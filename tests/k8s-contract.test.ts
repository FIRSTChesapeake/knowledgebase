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

const SECCOMP_OK = ["RuntimeDefault", "Localhost"]

// Every way a pod spec escapes the lockdown; [] when it holds. Walks
// containers, initContainers and ephemeralContainers alike.
function podSecurityProblems(pod: any): string[] {
  const problems: string[] = []
  const bad = (what: string) => problems.push(what)

  for (const key of ["hostNetwork", "hostPID", "hostIPC", "shareProcessNamespace"]) {
    if (pod[key] !== undefined && pod[key] !== false) bad(`pod ${key}`)
  }
  if (pod.hostUsers === true) bad("pod hostUsers")
  if (pod.hostAliases !== undefined) bad("pod hostAliases")
  for (const v of pod.volumes ?? []) {
    if (v.hostPath !== undefined) bad(`volume ${v.name} is a hostPath`)
    if (!v.emptyDir) bad(`volume ${v.name} is not an emptyDir`)
  }

  const psc = pod.securityContext ?? {}
  if (psc.runAsNonRoot !== true) bad("pod runAsNonRoot is not true")
  if (typeof psc.runAsUser !== "number" || psc.runAsUser === 0) bad("pod runAsUser is not a non-zero number")
  if (psc.runAsGroup === 0) bad("pod runAsGroup 0")
  if (psc.seccompProfile?.type !== "RuntimeDefault") bad("pod seccompProfile is not RuntimeDefault")
  for (const key of ["seLinuxOptions", "windowsOptions"]) {
    if (psc[key] !== undefined) bad(`pod ${key}`)
  }

  const all = [
    ...(pod.containers ?? []).map((c: any) => ["container", c]),
    ...(pod.initContainers ?? []).map((c: any) => ["initContainer", c]),
    ...(pod.ephemeralContainers ?? []).map((c: any) => ["ephemeralContainer", c]),
  ]
  for (const [kind, c] of all) {
    const at = `${kind} ${c.name}`
    if (c.image !== "knowledgebase") bad(`${at} image ${c.image}`)
    for (const p of c.ports ?? []) if (p.hostPort !== undefined) bad(`${at} hostPort ${p.hostPort}`)

    const sc = c.securityContext ?? {}
    if (sc.allowPrivilegeEscalation !== false) bad(`${at} allowPrivilegeEscalation is not false`)
    if (sc.readOnlyRootFilesystem !== true) bad(`${at} readOnlyRootFilesystem is not true`)
    if (sc.privileged !== undefined && sc.privileged !== false) bad(`${at} privileged`)
    if (!sc.capabilities?.drop?.includes("ALL")) bad(`${at} does not drop ALL`)
    if ((sc.capabilities?.add ?? []).length > 0) bad(`${at} adds capabilities`)
    // Container settings override the pod's.
    if (sc.runAsNonRoot === false) bad(`${at} runAsNonRoot false`)
    if (sc.runAsUser === 0) bad(`${at} runAsUser 0`)
    if (sc.runAsGroup === 0) bad(`${at} runAsGroup 0`)
    for (const key of ["procMount", "seLinuxOptions", "windowsOptions"]) {
      if (sc[key] !== undefined) bad(`${at} ${key}`)
    }
    if (sc.seccompProfile !== undefined && !SECCOMP_OK.includes(sc.seccompProfile.type)) {
      bad(`${at} seccompProfile ${sc.seccompProfile.type}`)
    }
  }
  return problems
}

// A locked-down extra container, so a case can break exactly one thing.
function lockedDown(name: string): any {
  return {
    name,
    image: "knowledgebase",
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
  }
}

const sc0 = (pod: any) => pod.containers[0].securityContext

// Each case breaks the real pod spec in one way the checks must catch.
const MUTATIONS: { name: string; mutate: (pod: any) => void }[] = [
  { name: "capabilities.add NET_ADMIN", mutate: (p) => (sc0(p).capabilities.add = ["NET_ADMIN"]) },
  { name: "capabilities.drop without ALL", mutate: (p) => (sc0(p).capabilities.drop = ["NET_RAW"]) },
  { name: "container privileged", mutate: (p) => (sc0(p).privileged = true) },
  { name: "container allowPrivilegeEscalation", mutate: (p) => (sc0(p).allowPrivilegeEscalation = true) },
  { name: "container writable root", mutate: (p) => (sc0(p).readOnlyRootFilesystem = false) },
  { name: "container runAsNonRoot false", mutate: (p) => (sc0(p).runAsNonRoot = false) },
  { name: "container runAsUser 0", mutate: (p) => (sc0(p).runAsUser = 0) },
  { name: "container runAsGroup 0", mutate: (p) => (sc0(p).runAsGroup = 0) },
  { name: "container procMount Unmasked", mutate: (p) => (sc0(p).procMount = "Unmasked") },
  { name: "container seLinuxOptions", mutate: (p) => (sc0(p).seLinuxOptions = { type: "spc_t" }) },
  { name: "container windowsOptions", mutate: (p) => (sc0(p).windowsOptions = { hostProcess: true }) },
  { name: "container seccomp Unconfined", mutate: (p) => (sc0(p).seccompProfile = { type: "Unconfined" }) },
  { name: "container image busybox", mutate: (p) => (p.containers[0].image = "busybox") },
  { name: "hostPort on a container port", mutate: (p) => (p.containers[0].ports[0].hostPort = 8080) },
  { name: "pod hostNetwork", mutate: (p) => (p.hostNetwork = true) },
  { name: "pod hostPID", mutate: (p) => (p.hostPID = true) },
  { name: "pod hostIPC", mutate: (p) => (p.hostIPC = true) },
  { name: "pod hostUsers true", mutate: (p) => (p.hostUsers = true) },
  { name: "pod hostAliases", mutate: (p) => (p.hostAliases = [{ ip: "10.0.0.1", hostnames: ["x"] }]) },
  { name: "pod shareProcessNamespace", mutate: (p) => (p.shareProcessNamespace = true) },
  { name: "hostPath volume", mutate: (p) => p.volumes.push({ name: "host", hostPath: { path: "/" } }) },
  // Past the emptyDir check, so only the hostPath check can catch it.
  { name: "hostPath beside an emptyDir", mutate: (p) => (p.volumes[0].hostPath = { path: "/" }) },
  { name: "pod windowsOptions", mutate: (p) => (p.securityContext.windowsOptions = { hostProcess: true }) },
  { name: "pod runAsNonRoot false", mutate: (p) => (p.securityContext.runAsNonRoot = false) },
  { name: "pod runAsUser 0", mutate: (p) => (p.securityContext.runAsUser = 0) },
  { name: "pod runAsGroup 0", mutate: (p) => (p.securityContext.runAsGroup = 0) },
  { name: "pod seccomp Unconfined", mutate: (p) => (p.securityContext.seccompProfile = { type: "Unconfined" }) },
  { name: "pod seLinuxOptions", mutate: (p) => (p.securityContext.seLinuxOptions = { type: "spc_t" }) },
  { name: "initContainer image busybox", mutate: (p) => (p.initContainers = [{ ...lockedDown("init"), image: "busybox" }]) },
  { name: "initContainer without the lockdown", mutate: (p) => (p.initContainers = [{ name: "init", image: "knowledgebase" }]) },
  {
    name: "initContainer adds a capability",
    mutate: (p) => {
      const c = lockedDown("init")
      c.securityContext.capabilities.add = ["SYS_ADMIN"]
      p.initContainers = [c]
    },
  },
  { name: "initContainer privileged", mutate: (p) => (p.initContainers = [{ ...lockedDown("init"), securityContext: { ...lockedDown("init").securityContext, privileged: true } }]) },
  { name: "ephemeralContainer image busybox", mutate: (p) => (p.ephemeralContainers = [{ ...lockedDown("debug"), image: "busybox" }]) },
  { name: "ephemeralContainer without the lockdown", mutate: (p) => (p.ephemeralContainers = [{ name: "debug", image: "knowledgebase" }]) },
  { name: "ephemeralContainer runAsUser 0", mutate: (p) => (p.ephemeralContainers = [{ ...lockedDown("debug"), securityContext: { ...lockedDown("debug").securityContext, runAsUser: 0 } }]) },
]

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

    test(`${file}: the pod spec has no security problems`, () => {
      assert.deepEqual(podSecurityProblems(pod), [])
    })

    describe(`${file}: each security check bites`, () => {
      // The control: lockedDown() extras alone must pass, so each case below
      // fails only for the one thing it breaks.
      test("a locked-down initContainer and ephemeralContainer pass", () => {
        const p = structuredClone(pod)
        p.initContainers = [lockedDown("init")]
        p.ephemeralContainers = [lockedDown("debug")]
        assert.deepEqual(podSecurityProblems(p), [])
      })

      for (const { name, mutate } of MUTATIONS) {
        test(name, () => {
          const p = structuredClone(pod)
          mutate(p)
          assert.notDeepEqual(podSecurityProblems(p), [], name)
        })
      }
    })

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
