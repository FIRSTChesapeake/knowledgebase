// Contract tests for the Kubernetes manifests in k8s-do/.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  appManifests,
  bootstrapManifests,
  listFiles,
  loadYamlDocs,
  readText,
  renderedPlaceholders,
  walkFiles,
} from "./helpers.ts"

const PLACEHOLDER = /__[A-Z_]+__/g
const CLUSTER_SCOPED = ["Namespace", "ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding"]
const DEPLOYER = "system:serviceaccount:__PROJECT_NAMESPACE__:kb-deployer"
const RESOURCE: Record<string, string> = {
  Deployment: "deployments",
  Service: "services",
  Ingress: "ingresses",
  NetworkPolicy: "networkpolicies",
}

// The placeholders the README's bootstrap render() substitutes.
function bootstrapRendered(): string[] {
  const readme = readText("k8s-do/README.md")
  const fn = readme.slice(readme.indexOf("render() {"), readme.indexOf("\n}", readme.indexOf("render() {")))
  return [...fn.matchAll(/-e "s\|(__[A-Z_]+__)\|/g)].map((m) => m[1]).sort()
}

function finalDockerUser(): number {
  const users = readText("Dockerfile")
    .split("\n")
    .filter((l) => /^USER\s+/.test(l))
  assert.ok(users.length > 0, "Dockerfile sets no USER")
  const value = users[users.length - 1].replace(/^USER\s+/, "").trim()
  assert.match(value, /^\d+$/, "the Dockerfile's final USER must be numeric")
  return Number(value)
}

function ofKind(kind: string) {
  return appManifests().filter(({ doc }) => doc.kind === kind)
}

describe("manifests never hard-code the domain", () => {
  const files = [
    ...walkFiles("k8s-do"),
    ...walkFiles("nginx"),
    "Dockerfile",
    ".dockerignore",
    ...walkFiles(".github/workflows"),
  ]

  test("no deployment file names a real host", () => {
    for (const file of files) {
      const text = readText(file)
      assert.ok(!text.includes("firstchs.org"), `${file} names firstchs.org`)
      assert.ok(!text.includes("github.io"), `${file} names github.io`)
    }
  })

  test("Ingress hosts are only __APP_DOMAIN__", () => {
    const ingresses = ofKind("Ingress")
    assert.ok(ingresses.length > 0)
    for (const { file, doc } of ingresses) {
      for (const rule of doc.spec.rules) assert.equal(rule.host, "__APP_DOMAIN__", file)
      for (const tls of doc.spec.tls) assert.deepEqual(tls.hosts, ["__APP_DOMAIN__"], file)
    }
  })

  test("placeholders used and placeholders rendered match exactly", () => {
    const used = new Set<string>()
    for (const file of listFiles("k8s-do", ".yaml")) {
      for (const m of readText(file).matchAll(PLACEHOLDER)) used.add(m[0])
    }
    const rendered = renderedPlaceholders()
    assert.equal(new Set(rendered).size, rendered.length, "a placeholder is rendered twice")
    assert.deepEqual([...used].sort(), rendered)
  })

  test("bootstrap placeholders and the README's render() match exactly", () => {
    const used = new Set<string>()
    for (const file of listFiles("k8s-do/bootstrap", ".yaml")) {
      for (const m of readText(file).matchAll(PLACEHOLDER)) used.add(m[0])
    }
    assert.deepEqual([...used].sort(), bootstrapRendered())
  })

  test("the README applies every bootstrap file", () => {
    const readme = readText("k8s-do/README.md")
    for (const file of listFiles("k8s-do/bootstrap", ".yaml")) {
      assert.match(readme, new RegExp(`^render ${file.replace(/\./g, "\\.")}\\s+\\| kubectl apply -f -$`, "m"), file)
    }
  })

  test("Ingress name, class, issuer and TLS secret are fixed", () => {
    const [{ doc }] = ofKind("Ingress")
    assert.equal(doc.metadata.name, "knowledgebase")
    assert.equal(doc.spec.ingressClassName, "nginx")
    assert.equal(doc.metadata.annotations["cert-manager.io/cluster-issuer"], "letsencrypt-prod")
    assert.equal(doc.spec.tls[0].secretName, "knowledgebase-tls")
  })
})

describe("every namespaced object is in the project namespace", () => {
  test("app and bootstrap objects carry namespace __PROJECT_NAMESPACE__", () => {
    const docs = [...appManifests(), ...bootstrapManifests()]
    for (const { file, doc } of docs) {
      if (doc.kind === "Namespace") {
        assert.equal(doc.metadata.name, "__PROJECT_NAMESPACE__", file)
      } else if (CLUSTER_SCOPED.includes(doc.kind)) {
        assert.equal(doc.metadata.namespace, undefined, `${file} ${doc.kind}`)
        assert.ok(doc.metadata.name.startsWith("__PROJECT_NAMESPACE__-"), `${file} ${doc.kind} name carries the namespace`)
      } else {
        assert.equal(doc.metadata.namespace, "__PROJECT_NAMESPACE__", `${file} ${doc.kind}`)
      }
      assert.equal(doc.metadata.labels?.["app.kubernetes.io/name"], "knowledgebase", file)
    }
  })

  test("app manifests contain no cluster-scoped or bootstrap kinds", () => {
    const forbidden = [...CLUSTER_SCOPED, "ClusterRole", "ClusterRoleBinding", "ServiceAccount", "Role", "RoleBinding", "Secret", "ResourceQuota", "LimitRange"]
    for (const { file, doc } of appManifests()) {
      assert.ok(!forbidden.includes(doc.kind), `${file} holds a ${doc.kind}`)
    }
  })
})

describe("non-root, read-only root, limits set", () => {
  const deployments = ofKind("Deployment")

  test("there is a Deployment", () => {
    assert.ok(deployments.length > 0)
  })

  for (const { file, doc } of deployments) {
    const pod = doc.spec.template.spec

    test(`${file}: every container is locked down and bounded`, () => {
      for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
        const sc = c.securityContext ?? {}
        assert.equal(sc.allowPrivilegeEscalation, false, c.name)
        assert.equal(sc.readOnlyRootFilesystem, true, c.name)
        assert.ok(sc.capabilities?.drop?.includes("ALL"), `${c.name} drops ALL`)
        for (const kind of ["requests", "limits"]) {
          assert.ok(c.resources?.[kind]?.cpu, `${c.name} ${kind}.cpu`)
          assert.ok(c.resources?.[kind]?.memory, `${c.name} ${kind}.memory`)
        }
      }
    })

    test(`${file}: pod runs as the image's numeric non-root user`, () => {
      const psc = pod.securityContext
      assert.equal(psc.runAsNonRoot, true)
      assert.equal(typeof psc.runAsUser, "number")
      assert.notEqual(psc.runAsUser, 0)
      assert.equal(psc.runAsUser, finalDockerUser())
      assert.equal(psc.seccompProfile?.type, "RuntimeDefault")
    })

    test(`${file}: /tmp is a writable emptyDir`, () => {
      const c = pod.containers[0]
      const mount = c.volumeMounts?.find((m: any) => m.mountPath === "/tmp")
      assert.ok(mount, "/tmp is mounted")
      const vol = pod.volumes?.find((v: any) => v.name === mount.name)
      assert.ok(vol?.emptyDir, "/tmp is an emptyDir")
    })

    test(`${file}: containers take literal env only and run the image's entrypoint`, () => {
      // The admission policy refuses anything else from the deploy credential.
      for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
        assert.equal(c.envFrom, undefined, c.name)
        for (const e of c.env ?? []) assert.equal(e.valueFrom, undefined, `${c.name} ${e.name}`)
        assert.equal(c.command, undefined, c.name)
        assert.equal(c.args, undefined, c.name)
      }
      for (const v of pod.volumes ?? []) assert.ok(v.emptyDir, `${v.name} is an emptyDir`)
    })

    test(`${file}: image is the rendered placeholder, no pull secret, no API token`, () => {
      for (const c of pod.containers) assert.equal(c.image, "__IMAGE__", c.name)
      assert.equal(pod.automountServiceAccountToken, false)
      assert.equal(pod.imagePullSecrets, undefined)
      assert.equal(pod.serviceAccountName, undefined)
    })
  }
})

describe("network policy shape", () => {
  const policies = ofKind("NetworkPolicy").map(({ doc }) => doc)
  const fromIngressNginx = (rule: any) =>
    rule.from?.some(
      (f: any) => f.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "ingress-nginx",
    )

  test("namespace isolation admits only same-namespace and ingress-nginx", () => {
    const iso = policies.find(
      (p) => Object.keys(p.spec.podSelector).length === 0 && p.spec.policyTypes.includes("Ingress"),
    )
    assert.ok(iso, "an all-pods ingress policy")
    assert.equal(iso.spec.ingress.length, 2)
    assert.ok(iso.spec.ingress.some((r: any) => r.from?.length === 1 && r.from[0].podSelector && !r.from[0].namespaceSelector))
    assert.ok(iso.spec.ingress.some(fromIngressNginx))
  })

  test("ACME solver is admitted from ingress-nginx", () => {
    const acme = policies.find(
      (p) => p.spec.podSelector.matchLabels?.["acme.cert-manager.io/http01-solver"] === "true",
    )
    assert.ok(acme, "an ACME solver policy")
    assert.ok(acme.spec.ingress.every(fromIngressNginx))
  })

  test("egress is denied to every pod", () => {
    const deny = policies.find(
      (p) => Object.keys(p.spec.podSelector).length === 0 && p.spec.policyTypes.includes("Egress"),
    )
    assert.ok(deny, "an all-pods egress policy")
    assert.ok(!deny.spec.egress || deny.spec.egress.length === 0, "the egress policy has no rules")
  })

  test("no policy admits from the cert-manager namespace", () => {
    assert.ok(!JSON.stringify(policies).includes('"cert-manager"'))
  })
})

describe("bootstrap stays out of CI and stays narrow", () => {
  test("the workflow never applies bootstrap manifests", () => {
    const text = readText(".github/workflows/deploy.yml")
    assert.ok(!text.includes("k8s-do/bootstrap"))
    assert.ok(!/cp -r k8s-do|cp -R k8s-do/.test(text), "render must copy top-level files only")
    for (const line of text.split("\n").filter((l) => l.includes("kubectl") && l.includes("apply"))) {
      assert.match(line, /k8s-do-rendered\/(network-policy|service|deployment|ingress)\.yaml/, line)
    }
  })

  const rbac = loadYamlDocs("k8s-do/bootstrap/deploy-rbac.yaml")

  test("deploy RBAC is a namespaced Role bound only to kb-deployer", () => {
    assert.ok(!rbac.some((d) => d.kind === "ClusterRole" || d.kind === "ClusterRoleBinding"))
    const role = rbac.find((d) => d.kind === "Role")
    assert.equal(role?.metadata.name, "kb-deployer")
    const binding = rbac.find((d) => d.kind === "RoleBinding")
    assert.equal(binding.roleRef.kind, "Role")
    assert.equal(binding.roleRef.name, "kb-deployer")
    assert.deepEqual(
      binding.subjects.map((s: any) => [s.kind, s.name]),
      [["ServiceAccount", "kb-deployer"]],
    )
  })

  test("deploy Role grants no secrets, no pod logs, no delete and no wildcards", () => {
    const role = rbac.find((d) => d.kind === "Role")
    for (const rule of role.rules) {
      assert.ok(!rule.resources.includes("pods/log"), "pods/log")
      assert.ok(!rule.resources.some((r: string) => r.startsWith("namespaces")), "namespaces")
      for (const field of ["apiGroups", "resources", "verbs"]) {
        assert.ok(!rule[field].includes("*"), `wildcard in ${field}`)
      }
      assert.ok(!rule.resources.includes("secrets"), "secrets")
      assert.ok(!rule.verbs.includes("delete") && !rule.verbs.includes("deletecollection"), "delete")
      assert.ok(!rule.verbs.some((v: string) => ["escalate", "bind", "impersonate"].includes(v)))
    }
  })

  test("deploy Role updates only the objects CI applies, by name", () => {
    const role = rbac.find((d) => d.kind === "Role")
    const names: Record<string, string[]> = {}
    for (const { doc } of appManifests()) {
      const resource = RESOURCE[doc.kind]
      ;(names[resource] ??= []).push(doc.metadata.name)
    }
    for (const rule of role.rules) {
      const writes = rule.verbs.filter((v: string) => v === "update" || v === "patch")
      if (writes.length === 0) continue
      assert.ok(rule.resourceNames?.length > 0, `${rule.resources} update/patch without resourceNames`)
      for (const r of rule.resources) assert.deepEqual([...rule.resourceNames].sort(), [...names[r]].sort(), r)
    }
    // Every app object stays updatable, or the next deploy fails.
    for (const [resource, objs] of Object.entries(names)) {
      for (const n of objs) {
        assert.ok(
          role.rules.some((r: any) => r.resources.includes(resource) && r.verbs.includes("patch") && r.resourceNames?.includes(n)),
          `${resource}/${n} is patchable`,
        )
      }
    }
  })

  test("no long-lived token Secret: the credential is a time-bound token", () => {
    for (const { file, doc } of bootstrapManifests()) {
      assert.ok(!(doc.kind === "Secret" && doc.type === "kubernetes.io/service-account-token"), file)
    }
    const readme = readText("k8s-do/README.md")
    assert.match(readme, /kubectl -n "\$NS" create token kb-deployer --duration=\d+h/)
    assert.ok(!readme.includes("get secret kb-deployer-token"), "README still reads the legacy token")
  })
})

describe("the deploy credential is bounded by the cluster, not only by RBAC", () => {
  const boot = bootstrapManifests().map(({ doc }) => doc)
  const policies = boot.filter((d) => d.kind === "ValidatingAdmissionPolicy")
  const bindings = boot.filter((d) => d.kind === "ValidatingAdmissionPolicyBinding")
  const ns = boot.find((d) => d.kind === "Namespace")
  const role = loadYamlDocs("k8s-do/bootstrap/deploy-rbac.yaml").find((d) => d.kind === "Role")

  // The policy admitting CREATE and UPDATE of a resource for the deployer.
  function policyFor(group: string, resource: string): any {
    const matching = policies.filter((p) =>
      p.spec.matchConstraints.resourceRules.some(
        (r: any) =>
          r.apiGroups.includes(group) &&
          r.resources.includes(resource) &&
          r.operations.includes("CREATE") &&
          r.operations.includes("UPDATE"),
      ),
    )
    assert.equal(matching.length, 1, `one policy for ${group}/${resource}`)
    return matching[0]
  }
  const expressions = (p: any) => p.spec.validations.map((v: any) => v.expression as string)

  test("the namespace enforces Pod Security restricted at a pinned version", () => {
    const labels = ns.metadata.labels
    assert.equal(labels["pod-security.kubernetes.io/enforce"], "restricted")
    assert.match(labels["pod-security.kubernetes.io/enforce-version"], /^v1\.\d+$/)
  })

  test("a ResourceQuota bounds pods, compute and exposed Services, and fits the Deployment", () => {
    const quota = boot.find((d) => d.kind === "ResourceQuota")
    assert.ok(quota, "a ResourceQuota")
    const hard = quota.spec.hard
    for (const k of ["pods", "requests.cpu", "requests.memory", "limits.cpu", "limits.memory"]) assert.ok(hard[k], k)
    assert.equal(hard["services.loadbalancers"], "0")
    assert.equal(hard["services.nodeports"], "0")
    assert.equal(hard.persistentvolumeclaims, "0")
    // A rolling update runs replicas + maxSurge pods at once.
    const [{ doc: dep }] = appManifests().filter(({ doc }) => doc.kind === "Deployment")
    const peak = dep.spec.replicas + dep.spec.strategy.rollingUpdate.maxSurge
    assert.ok(Number(hard.pods) > peak, "room for the rollout and an ACME solver pod")
    const c = dep.spec.template.spec.containers[0].resources.limits
    assert.ok(peak * cpu(c.cpu) < cpu(hard["limits.cpu"]), "limits.cpu")
    assert.ok(peak * mem(c.memory) < mem(hard["limits.memory"]), "limits.memory")
  })

  test("a LimitRange gives defaults and admits the Deployment's containers", () => {
    const lr = boot.find((d) => d.kind === "LimitRange")
    assert.ok(lr, "a LimitRange")
    const container = lr.spec.limits.find((l: any) => l.type === "Container")
    for (const k of ["default", "defaultRequest", "max"]) assert.ok(container[k]?.cpu && container[k]?.memory, k)
    const [{ doc: dep }] = appManifests().filter(({ doc }) => doc.kind === "Deployment")
    for (const c of dep.spec.template.spec.containers) {
      assert.ok(cpu(c.resources.limits.cpu) <= cpu(container.max.cpu), c.name)
      assert.ok(mem(c.resources.limits.memory) <= mem(container.max.memory), c.name)
    }
  })

  test("every kind the deployer can create or update has a policy, bound and denying", () => {
    const writable = role.rules.filter((r: any) => r.verbs.some((v: string) => ["create", "update", "patch"].includes(v)))
    assert.ok(writable.length > 0)
    for (const rule of writable) {
      for (const group of rule.apiGroups) {
        for (const resource of rule.resources) {
          const p = policyFor(group, resource)
          assert.equal(p.spec.failurePolicy, "Fail", p.metadata.name)
          const binding = bindings.filter((b) => b.spec.policyName === p.metadata.name)
          assert.equal(binding.length, 1, `${p.metadata.name} is bound`)
          assert.deepEqual(binding[0].spec.validationActions, ["Deny"])
          assert.deepEqual(binding[0].spec.matchResources.namespaceSelector.matchLabels, {
            "kubernetes.io/metadata.name": "__PROJECT_NAMESPACE__",
          })
        }
      }
    }
  })

  test("each policy matches exactly the deploy credential", () => {
    // Not cert-manager: its HTTP-01 solver creates its own Ingress, Service
    // and pod in this namespace.
    assert.equal(policies.length, 4)
    for (const p of policies) {
      assert.deepEqual(p.spec.matchConditions, [
        { name: "deploy-credential-only", expression: `request.userInfo.username == '${DEPLOYER}'` },
      ])
    }
    assert.ok(role, "the Role the username belongs to")
  })

  test("Deployments: only knowledgebase, emptyDir, default SA, no token, digest-pinned image, no secret env", () => {
    const e = expressions(policyFor("apps", "deployments")).join("\n")
    for (const needle of [
      "object.metadata.name == 'knowledgebase'",
      "variables.pod.volumes.all(v, has(v.emptyDir))",
      "variables.pod.serviceAccountName in ['', 'default']",
      "variables.pod.serviceAccount in ['', 'default']",
      "has(variables.pod.automountServiceAccountToken) && variables.pod.automountServiceAccountToken == false",
      "!has(c.envFrom)",
      "!has(e.valueFrom)",
      "!has(c.command) && !has(c.args)",
    ]) {
      assert.ok(e.includes(needle), needle)
    }
    const vars = policyFor("apps", "deployments").spec.variables
    assert.ok(vars.find((v: any) => v.name === "containers").expression.includes("initContainers"), "init containers are checked too")
  })

  test("Deployments: the image pattern admits a digest and refuses tags and other repos", () => {
    const e = expressions(policyFor("apps", "deployments")).find((x: string) => x.includes(".matches("))
    const pattern = /c\.image\.matches\('([^']+)'\)/.exec(e)?.[1]
    assert.ok(pattern, "an image pattern")
    const re = new RegExp(pattern.replace("__GHCR_OWNER__", "firstchesapeake"))
    const digest = "ab".repeat(32)
    assert.ok(re.test(`ghcr.io/firstchesapeake/knowledgebase@sha256:${digest}`))
    for (const bad of [
      "ghcr.io/firstchesapeake/knowledgebase:sha-0123456789ab",
      "ghcr.io/firstchesapeake/knowledgebase:latest",
      `ghcr.io/firstchesapeake/knowledgebase:v1@sha256:${digest}`,
      `ghcr.io/someone-else/knowledgebase@sha256:${digest}`,
      `ghcrxio/firstchesapeake/knowledgebase@sha256:${digest}`,
      `docker.io/library/busybox@sha256:${digest}`,
      `ghcr.io/firstchesapeake/knowledgebase@sha256:${digest}0`,
    ]) {
      assert.ok(!re.test(bad), bad)
    }
  })

  test("Ingresses: only knowledgebase on APP_DOMAIN, no controller annotations", () => {
    const e = expressions(policyFor("networking.k8s.io", "ingresses")).join("\n")
    for (const needle of [
      "object.metadata.name == 'knowledgebase'",
      "object.spec.ingressClassName == 'nginx'",
      "!has(object.spec.defaultBackend)",
      "object.spec.rules.all(r, has(r.host) && r.host == '__APP_DOMAIN__')",
      "t.hosts.all(h, h == '__APP_DOMAIN__')",
      "p.backend.service.name == 'knowledgebase'",
      "object.metadata.annotations.all(k, k in ['cert-manager.io/cluster-issuer', 'kubectl.kubernetes.io/last-applied-configuration'])",
      "object.metadata.annotations['cert-manager.io/cluster-issuer'] == 'letsencrypt-prod'",
    ]) {
      assert.ok(e.includes(needle), needle)
    }
  })

  test("the app's own Ingress passes the Ingress policy's allowlist", () => {
    const [{ doc }] = appManifests().filter(({ doc }) => doc.kind === "Ingress")
    for (const k of Object.keys(doc.metadata.annotations ?? {})) {
      assert.ok(["cert-manager.io/cluster-issuer"].includes(k), k)
      assert.ok(!k.startsWith("nginx.ingress.kubernetes.io/"), k)
    }
    assert.equal(doc.spec.defaultBackend, undefined)
    for (const r of doc.spec.rules) for (const p of r.http.paths) assert.equal(p.backend.service.name, "knowledgebase")
  })

  test("Services and NetworkPolicies: only the names CI applies, ClusterIP only", () => {
    const svc = expressions(policyFor("", "services")).join("\n")
    assert.ok(svc.includes("object.metadata.name == 'knowledgebase'"))
    assert.ok(svc.includes("object.spec.type == 'ClusterIP'"))
    assert.ok(svc.includes("externalIPs"))
    const np = expressions(policyFor("networking.k8s.io", "networkpolicies")).join("\n")
    const listed = /object\.metadata\.name in \[([^\]]+)\]/.exec(np)?.[1]
    assert.ok(listed, "a name allowlist")
    const names = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    const applied = appManifests()
      .filter(({ doc }) => doc.kind === "NetworkPolicy")
      .map(({ doc }) => doc.metadata.name)
      .sort()
    assert.deepEqual(names, applied)
  })

  test("the docs no longer claim RBAC alone keeps Secrets out of reach", () => {
    const readme = readText("k8s-do/README.md")
    assert.ok(!/has no access to Secrets/.test(readme))
    assert.match(readme, /RBAC alone cannot/)
  })
})

describe("who may deploy is documented as required repo settings", () => {
  const readme = readText("k8s-do/README.md")
  const section = readme.slice(readme.indexOf("### Required: who can deploy"), readme.indexOf("## Bootstrap"))

  test("production is limited to v* tags, with reviewers and no admin bypass", () => {
    assert.ok(section.length > 0, "the section exists")
    assert.match(section, /Environment `production`/)
    assert.match(section, /tag `v\*`/)
    assert.match(section, /Required reviewers/)
    assert.match(section, /bypass configured protection rules:\*\* off/)
  })

  test("a v* tag ruleset and the github-pages tag rule are required too", () => {
    assert.match(section, /tag ruleset\*\* targeting `v\*`/)
    assert.match(section, /Environment `github-pages`: add the tag rule `v\*`/)
  })

  test("the in-workflow guard is called a safety net, not the control", () => {
    assert.match(section, /The guard is a safety\s+net, not the security control/)
    assert.match(readText(".github/workflows/deploy.yml"), /It is a safety\n# net; the security control is the repo settings/)
  })
})

// Kubernetes quantities used in these manifests: millicores or cores, Mi or Gi.
function cpu(q: string): number {
  return q.endsWith("m") ? Number(q.slice(0, -1)) : Number(q) * 1000
}
function mem(q: string): number {
  const m = /^(\d+)(Mi|Gi)$/.exec(q)
  assert.ok(m, `quantity ${q}`)
  return Number(m[1]) * (m[2] === "Gi" ? 1024 : 1)
}
