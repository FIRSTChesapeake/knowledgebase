// Contract tests for the Kubernetes manifests in k8s-do/.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import {
  BAD_DOMAINS,
  GOOD_DOMAINS,
  appManifests,
  bootstrapManifests,
  listFiles,
  loadYamlDocs,
  readText,
  renderedPlaceholders,
  runBash,
  scratchDir,
  walkFiles,
} from "./helpers.ts"

const PLACEHOLDER = /__[A-Z_]+__/g
const CLUSTER_SCOPED = ["Namespace", "ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding"]
const DEPLOYER = "system:serviceaccount:__PROJECT_NAMESPACE__:kb-deployer"
const RESOURCE: Record<string, string> = {
  Deployment: "deployments",
  Service: "services",
  Ingress: "ingresses",
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
  const policies = bootstrapManifests()
    .filter(({ doc }) => doc.kind === "NetworkPolicy")
    .map(({ doc }) => doc)
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

  test("NetworkPolicies are the admin's: bootstrap only, out of CI and the Role", () => {
    assert.equal(policies.length, 3)
    assert.deepEqual(ofKind("NetworkPolicy"), [], "no NetworkPolicy among the CI-applied manifests")
    const role = loadYamlDocs("k8s-do/bootstrap/deploy-rbac.yaml").find((d) => d.kind === "Role")
    for (const rule of role.rules) assert.ok(!rule.resources.includes("networkpolicies"), String(rule.resources))
    assert.ok(!readText(".github/workflows/deploy.yml").includes("network-policy"))
  })
})

describe("bootstrap stays out of CI and stays narrow", () => {
  test("the workflow never applies bootstrap manifests", () => {
    const text = readText(".github/workflows/deploy.yml")
    assert.ok(!text.includes("k8s-do/bootstrap"))
    assert.ok(!/cp -r k8s-do|cp -R k8s-do/.test(text), "render must copy top-level files only")
    for (const line of text.split("\n").filter((l) => l.includes("kubectl") && l.includes("apply"))) {
      assert.match(line, /k8s-do-rendered\/(service|deployment|ingress)\.yaml/, line)
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
    assert.equal(policies.length, 3)
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

  test("Deployments: no lifecycle hooks, httpGet /healthz probes only, read-only root, no escalation", () => {
    const e = expressions(policyFor("apps", "deployments")).join("\n")
    assert.ok(e.includes("variables.containers.all(c, !has(c.lifecycle))"), "lifecycle")
    for (const probe of ["livenessProbe", "readinessProbe", "startupProbe"]) {
      const needle = `(!has(c.${probe}) || (has(c.${probe}.httpGet) && !has(c.${probe}.httpGet.host) && c.${probe}.httpGet.path == '/healthz'))`
      assert.ok(e.includes(needle), probe)
    }
    assert.ok(e.includes("has(c.securityContext.readOnlyRootFilesystem) && c.securityContext.readOnlyRootFilesystem == true"))
    assert.ok(e.includes("has(c.securityContext.allowPrivilegeEscalation) && c.securityContext.allowPrivilegeEscalation == false"))
    // The app's own Deployment must still pass.
    const [{ doc: dep }] = appManifests().filter(({ doc }) => doc.kind === "Deployment")
    for (const c of dep.spec.template.spec.containers) {
      assert.equal(c.lifecycle, undefined)
      for (const probe of ["livenessProbe", "readinessProbe", "startupProbe"]) {
        if (!c[probe]) continue
        assert.equal(c[probe].httpGet?.path, "/healthz", probe)
        assert.equal(c[probe].httpGet.host, undefined, probe)
      }
      assert.equal(c.securityContext.readOnlyRootFilesystem, true)
      assert.equal(c.securityContext.allowPrivilegeEscalation, false)
    }
  })

  test("Deployments: no say over placement, priority, runtime, /etc/hosts or debug containers", () => {
    const e = expressions(policyFor("apps", "deployments")).join("\n")
    const fields = ["nodeName", "nodeSelector", "affinity", "tolerations", "priorityClassName", "runtimeClassName", "hostAliases", "ephemeralContainers"]
    for (const f of fields) assert.ok(e.includes(`!has(variables.pod.${f})`), f)
    const [{ doc: dep }] = appManifests().filter(({ doc }) => doc.kind === "Deployment")
    for (const f of fields) assert.equal(dep.spec.template.spec[f], undefined, f)
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

  test("Ingresses: TLS required, Prefix or Exact paths of plain characters", () => {
    const all = expressions(policyFor("networking.k8s.io", "ingresses"))
    const e = all.join("\n")
    assert.ok(e.includes("has(object.spec.tls) && size(object.spec.tls) > 0 &&"), "tls: [] is refused")
    assert.ok(e.includes("has(p.pathType) && p.pathType in ['Prefix', 'Exact']"), "pathType")
    const pattern = /p\.path\.matches\('([^']+)'\)/.exec(e)?.[1]
    assert.ok(pattern, "a path pattern")
    assert.ok(e.includes("has(p.path) && p.path.matches("))
    const re = new RegExp(pattern)
    for (const good of ["/", "/static/contentIndex.json", "/FRC/", "/a_b-c.d"]) assert.ok(re.test(good), good)
    for (const bad of ["", "x", "/(.*)", "/x$", "/a b", "/x;y", "/x{", "/~x", "/x\n"]) assert.ok(!re.test(bad), JSON.stringify(bad))
    const [{ doc }] = appManifests().filter(({ doc }) => doc.kind === "Ingress")
    assert.ok(doc.spec.tls.length > 0)
    for (const r of doc.spec.rules) {
      for (const p of r.http.paths) {
        assert.ok(["Prefix", "Exact"].includes(p.pathType), p.pathType)
        assert.ok(re.test(p.path), p.path)
      }
    }
  })

  test("Deployments: only the default scheduler", () => {
    const e = expressions(policyFor("apps", "deployments")).join("\n")
    assert.ok(e.includes("!has(variables.pod.schedulerName) || variables.pod.schedulerName == 'default-scheduler'"))
    const [{ doc: dep }] = appManifests().filter(({ doc }) => doc.kind === "Deployment")
    assert.ok([undefined, "default-scheduler"].includes(dep.spec.template.spec.schedulerName))
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

  test("Services: only knowledgebase, ClusterIP only", () => {
    const svc = expressions(policyFor("", "services")).join("\n")
    assert.ok(svc.includes("object.metadata.name == 'knowledgebase'"))
    assert.ok(svc.includes("object.spec.type == 'ClusterIP'"))
    assert.ok(svc.includes("externalIPs"))
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

  test("production needs a reviewer other than whoever started the run", () => {
    assert.match(section, /\*\*Prevent self-review:\*\* on/)
  })

  test("the reviewer checklist covers the tag, main and an unmodified workflow", () => {
    const list = section.slice(section.indexOf("Before approving a `production` deployment"))
    assert.match(list, /run is for a `v\*` tag/)
    assert.match(list, /tagged commit is on `main`/)
    assert.match(list, /git diff origin\/main <tag> -- \.github\/workflows\/deploy\.yml/)
  })

  test("image-publish is described as gating the unmodified workflow, not repo writers", () => {
    for (const text of [section, readText(".github/workflows/deploy.yml")]) {
      assert.ok(!/keeps `?packages: write`? off/.test(text), "overclaims what the environment does")
      assert.match(text, /not a\s+control against/)
    }
    assert.match(section, /ruleset\*\* on all branches that restricts\s+changes to `\.github\/workflows\/\*\*`/)
  })

  test("the cutover dispatches from a v* tag, never a branch", () => {
    const step = readme.slice(readme.indexOf("## Cutover checklist"))
    assert.match(step, /1\. Deploy \(push a version tag, or dispatch the workflow from a `v\*` tag;/)
    assert.ok(!/dispatch the workflow on `main`/.test(readme))
  })

  test("the in-workflow guard is called a safety net, not the control", () => {
    assert.match(section, /The guard is a safety\s+net, not the security control/)
    assert.match(readText(".github/workflows/deploy.yml"), /It is a safety\n# net; the security control is the repo settings/)
  })
})

describe("the README's bootstrap render() checks its inputs", () => {
  const readme = readText("k8s-do/README.md")
  const start = readme.indexOf("render() {")
  const fn = readme.slice(start, readme.indexOf("\n}", start) + 2)
  const dir = scratchDir()
  const file = path.join(dir, "in.yaml")
  fs.writeFileSync(file, "ns: __PROJECT_NAMESPACE__\nhost: __APP_DOMAIN__\nowner: __GHCR_OWNER__\n")
  const good = { NS: "kb", APP_DOMAIN: "kb.example.org", GHCR_OWNER: "firstchesapeake" }
  const render = (vals: Record<string, string>) => runBash(`${fn}\nrender "$F"`, { ...vals, F: file })

  test("runs under set -u", () => {
    assert.match(readme.slice(readme.lastIndexOf("```sh", start), start), /^set -u$/m)
  })

  test("renders good values", () => {
    const r = render(good)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, "ns: kb\nhost: kb.example.org\nowner: firstchesapeake\n")
    for (const APP_DOMAIN of GOOD_DOMAINS) assert.equal(render({ ...good, APP_DOMAIN }).status, 0, APP_DOMAIN)
  })

  test("prints nothing and fails for a bad namespace, domain or owner", () => {
    const bad: Record<string, string>[] = [
      ...BAD_DOMAINS.map((APP_DOMAIN) => ({ ...good, APP_DOMAIN })),
      ...["", "KB", "kb_x", "kb|x", "kb\n", "-kb", "kb.x", "a".repeat(64)].map((NS) => ({ ...good, NS })),
      ...["", "FirstChesapeake", "first|x", "first/x", "first.x", "first\n"].map((GHCR_OWNER) => ({ ...good, GHCR_OWNER })),
    ]
    for (const vals of bad) {
      const r = render(vals)
      assert.notEqual(r.status, 0, JSON.stringify(vals))
      assert.equal(r.stdout, "", JSON.stringify(vals))
    }
  })
})

describe("the bootstrap docs cover what the manifests cannot", () => {
  const readme = readText("k8s-do/README.md")

  test("the admin is told to confirm no Pod Security exemptions apply", () => {
    assert.match(readme, /exempted username,\s+namespace or RuntimeClass skips `restricted` entirely/)
    assert.match(readme, /`AdmissionConfiguration`/)
  })

  test("the smoke check tries a breadth of refused writes", () => {
    const block = readme.slice(readme.indexOf("Check that the policies bite"), readme.indexOf("## Build the deploy kubeconfig"))
    for (const needle of ["hostPath", '"exec"', "create deployment probe", "other.example", "server-snippet", "LoadBalancer", '"kind":"NetworkPolicy"']) {
      assert.ok(block.includes(needle), needle)
    }
    for (const line of block.split("\n").filter((l) => l.startsWith("kubectl "))) {
      assert.match(line, /^kubectl \$D /, "every probe is a server-side dry run as kb-deployer")
    }
    assert.match(block, /^D="-n \$NS \$AS --dry-run=server -o name"$/m)
    for (const needle of ['containers/0/lifecycle"', 'readOnlyRootFilesystem","value":false', 'spec/tolerations"', 'spec/nodeName"']) {
      assert.ok(block.includes(needle), needle)
    }
  })

  test("migrating an older bootstrap removes the NetworkPolicy access and policy, in order", () => {
    const m = readme.slice(readme.indexOf("### Migrating a cluster bootstrapped before the NetworkPolicies moved here"))
    const steps = [
      "render k8s-do/bootstrap/deploy-rbac.yaml | kubectl apply -f -",
      'kubectl auth can-i create networkpolicies --as=system:serviceaccount:$NS:kb-deployer -n "$NS"',
      'kubectl delete validatingadmissionpolicybinding "$NS-kb-deployer-networkpolicies"',
      'kubectl delete validatingadmissionpolicy "$NS-kb-deployer-networkpolicies"',
      'kubectl get netpol -n "$NS"',
    ]
    let at = 0
    for (const step of steps) {
      const i = m.indexOf(step, at)
      assert.ok(i >= 0, `${step} (in order)`)
      at = i
    }
    assert.match(m, /must print `no`/)
    // The names deleted are the ones the policy was shipped under.
    // The names deleted follow the scheme the policies ship under.
    for (const { doc } of bootstrapManifests().filter(({ doc }) => doc.kind.startsWith("ValidatingAdmissionPolicy"))) {
      assert.match(doc.metadata.name, /^__PROJECT_NAMESPACE__-kb-deployer-[a-z]+$/)
    }
    for (const name of ["default-namespace-isolation", "allow-acme-solver", "default-deny-egress"]) assert.ok(m.includes(name), name)
  })

  test("rollback says which tags can be re-deployed and points older ones at rollout undo", () => {
    const r = readme.slice(readme.indexOf("## Rollback"), readme.indexOf("## Cutover checklist"))
    assert.match(r, /works only for a tag\s+whose `deploy\.yml` is the one on `main`/)
    assert.match(r, /`rollout undo` instead/)
    assert.ok(!/^Or re-run the workflow for an earlier version tag\./m.test(r))
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
