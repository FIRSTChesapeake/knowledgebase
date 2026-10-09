// Contract tests for the Kubernetes manifests in k8s-do/, which the release
// workflow publishes as the artifact the cluster applies. The namespace,
// its policies and the deployer Role are the cluster config repo's; these
// tests hold the manifests to what those policies admit.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { appManifests, kustomization, listFiles, readText } from "./helpers.ts"

const RESOURCES = ["service.yaml", "deployment.yaml", "ingress.yaml"]

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

describe("kustomization.yaml", () => {
  const k = kustomization()

  test("lists exactly the three app files", () => {
    assert.equal(k.apiVersion, "kustomize.config.k8s.io/v1beta1")
    assert.equal(k.kind, "Kustomization")
    assert.deepEqual(k.resources, RESOURCES)
    const yaml = listFiles("k8s-do", ".yaml").map((f) => f.replace(/^k8s-do\//, ""))
    assert.deepEqual(yaml.sort(), [...RESOURCES, "kustomization.yaml"].sort(), "no YAML file outside the release")
  })

  test("holds no images, labels, namespace or generators", () => {
    // images: is written by the release job into its own copy only.
    const allowed = ["apiVersion", "kind", "resources"]
    for (const key of Object.keys(k)) assert.ok(allowed.includes(key), `kustomization.yaml sets ${key}`)
  })
})

describe("the cluster fills in the environment", () => {
  test("the only substitution variable is ${APP_DOMAIN}, and no __X__ placeholder is left", () => {
    for (const file of listFiles("k8s-do", ".yaml")) {
      const text = readText(file)
      assert.ok(!/__[A-Z_]+__/.test(text), `${file} holds an __X__ placeholder`)
      const vars = [...text.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1])
      for (const v of vars) assert.equal(v, "APP_DOMAIN", `${file}: \${${v}}`)
    }
  })

  test("Ingress hosts are only ${APP_DOMAIN}", () => {
    const ingresses = ofKind("Ingress")
    assert.ok(ingresses.length > 0)
    for (const { file, doc } of ingresses) {
      for (const rule of doc.spec.rules) assert.equal(rule.host, "${APP_DOMAIN}", file)
      for (const tls of doc.spec.tls) assert.deepEqual(tls.hosts, ["${APP_DOMAIN}"], file)
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

describe("the release holds only the app, unplaced", () => {
  test("no object names a namespace", () => {
    for (const { file, doc } of appManifests()) assert.equal(doc.metadata.namespace, undefined, `${file} ${doc.kind}`)
  })

  test("every object is labelled knowledgebase", () => {
    for (const { file, doc } of appManifests()) {
      assert.equal(doc.metadata.labels?.["app.kubernetes.io/name"], "knowledgebase", file)
      assert.equal(doc.metadata.labels?.["app.kubernetes.io/part-of"], "knowledgebase", file)
    }
  })

  test("exactly one Service, Deployment and Ingress, all named knowledgebase", () => {
    const kinds = appManifests().map(({ doc }) => `${doc.kind}/${doc.metadata.name}`)
    assert.deepEqual(kinds.sort(), ["Deployment/knowledgebase", "Ingress/knowledgebase", "Service/knowledgebase"])
  })

  test("no file in k8s-do/ holds a Secret", () => {
    for (const file of listFiles("k8s-do", ".yaml")) {
      assert.ok(!/^kind:\s*Secret\s*$/m.test(readText(file)), `${file} holds a Secret`)
    }
  })

  test("the Deployment selector is unchanged: it is immutable once created", () => {
    const [{ doc }] = ofKind("Deployment")
    assert.deepEqual(doc.spec.selector.matchLabels, { "app.kubernetes.io/name": "knowledgebase" })
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

    test(`${file}: image is the bare name the release pins, no pull secret, no API token`, () => {
      // The release job bakes the digest in; un-baked, admission refuses it.
      for (const c of pod.containers) assert.equal(c.image, "knowledgebase", c.name)
      assert.equal(pod.automountServiceAccountToken, false)
      assert.equal(pod.imagePullSecrets, undefined)
      assert.equal(pod.serviceAccountName, undefined)
    })
  }
})

// The admission policies are the config repo's; the app's own objects must
// keep passing them.
describe("the app passes the cluster's admission policies", () => {
  test("Deployment: no lifecycle hooks, httpGet /healthz probes only", () => {
    const [{ doc: dep }] = ofKind("Deployment")
    for (const c of dep.spec.template.spec.containers) {
      assert.equal(c.lifecycle, undefined)
      for (const probe of ["livenessProbe", "readinessProbe", "startupProbe"]) {
        if (!c[probe]) continue
        assert.equal(c[probe].httpGet?.path, "/healthz", probe)
        assert.equal(c[probe].httpGet.host, undefined, probe)
      }
    }
  })

  test("Deployment: only the default scheduler", () => {
    const [{ doc: dep }] = ofKind("Deployment")
    assert.ok([undefined, "default-scheduler"].includes(dep.spec.template.spec.schedulerName))
  })

  test("Ingress: only the issuer annotation, no default backend, TLS, plain Prefix or Exact paths", () => {
    const [{ doc }] = ofKind("Ingress")
    for (const k of Object.keys(doc.metadata.annotations ?? {})) {
      assert.ok(["cert-manager.io/cluster-issuer"].includes(k), k)
    }
    assert.equal(doc.spec.defaultBackend, undefined)
    assert.ok(doc.spec.tls.length > 0)
    for (const r of doc.spec.rules) {
      for (const p of r.http.paths) {
        assert.equal(p.backend.service.name, "knowledgebase")
        assert.ok(["Prefix", "Exact"].includes(p.pathType), p.pathType)
        assert.match(p.path, /^\/[A-Za-z0-9._/-]*$/)
      }
    }
  })

  test("Service: only knowledgebase, ClusterIP, no external IPs", () => {
    const [{ doc }] = ofKind("Service")
    assert.equal(doc.metadata.name, "knowledgebase")
    assert.equal(doc.spec.type, "ClusterIP")
    assert.equal(doc.spec.externalIPs, undefined)
  })
})
