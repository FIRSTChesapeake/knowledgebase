// Contract tests for the Kubernetes manifests in k8s-do/.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  appManifests,
  listFiles,
  loadYamlDocs,
  readText,
  renderedPlaceholders,
  walkFiles,
} from "./helpers.ts"

const PLACEHOLDER = /__[A-Z_]+__/g

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

  test("bootstrap manifests use only placeholders the render list knows", () => {
    const rendered = new Set(renderedPlaceholders())
    for (const file of listFiles("k8s-do/bootstrap", ".yaml")) {
      for (const m of readText(file).matchAll(PLACEHOLDER)) {
        assert.ok(rendered.has(m[0]), `${file} uses ${m[0]}`)
      }
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
    const docs = [
      ...appManifests(),
      ...listFiles("k8s-do/bootstrap", ".yaml").flatMap((file) =>
        loadYamlDocs(file).map((doc) => ({ file, doc })),
      ),
    ]
    for (const { file, doc } of docs) {
      if (doc.kind === "Namespace") {
        assert.equal(doc.metadata.name, "__PROJECT_NAMESPACE__", file)
      } else {
        assert.equal(doc.metadata.namespace, "__PROJECT_NAMESPACE__", `${file} ${doc.kind}`)
      }
      assert.equal(doc.metadata.labels?.["app.kubernetes.io/name"], "knowledgebase", file)
    }
  })

  test("app manifests contain no cluster-scoped or bootstrap kinds", () => {
    const forbidden = ["Namespace", "ClusterRole", "ClusterRoleBinding", "ServiceAccount", "Role", "RoleBinding", "Secret"]
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

  test("deploy Role grants no secrets, no delete and no wildcards", () => {
    const role = rbac.find((d) => d.kind === "Role")
    for (const rule of role.rules) {
      for (const field of ["apiGroups", "resources", "verbs"]) {
        assert.ok(!rule[field].includes("*"), `wildcard in ${field}`)
      }
      assert.ok(!rule.resources.includes("secrets"), "secrets")
      assert.ok(!rule.verbs.includes("delete") && !rule.verbs.includes("deletecollection"), "delete")
      assert.ok(!rule.verbs.some((v: string) => ["escalate", "bind", "impersonate"].includes(v)))
    }
  })
})
