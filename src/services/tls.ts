import tls from "node:tls";

/**
 * VTOP's server (vtopcc.vit.ac.in) presents an INCOMPLETE certificate chain: it
 * sends only the leaf (*.vit.ac.in) and omits the intermediate "Sectigo RSA
 * Domain Validation Secure Server CA". Browsers paper over this by fetching the
 * intermediate via the leaf's AIA URL; Node does not, so it fails with "unable
 * to verify the first certificate". We bundle the (public) intermediate here and
 * supply it to the VTOP HTTPS agent so the chain completes WITHOUT disabling
 * verification — unlike VTOP_INSECURE_TLS, this keeps every other connection
 * (Redis, etc.) fully verified. Source: http://crt.sectigo.com/SectigoRSADomainValidationSecureServerCA.crt
 */
const SECTIGO_RSA_DV_INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIGEzCCA/ugAwIBAgIQfVtRJrR2uhHbdBYLvFMNpzANBgkqhkiG9w0BAQwFADCB
iDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0pl
cnNleSBDaXR5MR4wHAYDVQQKExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNV
BAMTJVVTRVJUcnVzdCBSU0EgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwHhcNMTgx
MTAyMDAwMDAwWhcNMzAxMjMxMjM1OTU5WjCBjzELMAkGA1UEBhMCR0IxGzAZBgNV
BAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UEBxMHU2FsZm9yZDEYMBYGA1UE
ChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFJTQSBEb21haW4g
VmFsaWRhdGlvbiBTZWN1cmUgU2VydmVyIENBMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEA1nMz1tc8INAA0hdFuNY+B6I/x0HuMjDJsGz99J/LEpgPLT+N
TQEMgg8Xf2Iu6bhIefsWg06t1zIlk7cHv7lQP6lMw0Aq6Tn/2YHKHxYyQdqAJrkj
eocgHuP/IJo8lURvh3UGkEC0MpMWCRAIIz7S3YcPb11RFGoKacVPAXJpz9OTTG0E
oKMbgn6xmrntxZ7FN3ifmgg0+1YuWMQJDgZkW7w33PGfKGioVrCSo1yfu4iYCBsk
Haswha6vsC6eep3BwEIc4gLw6uBK0u+QDrTBQBbwb4VCSmT3pDCg/r8uoydajotY
uK3DGReEY+1vVv2Dy2A0xHS+5p3b4eTlygxfFQIDAQABo4IBbjCCAWowHwYDVR0j
BBgwFoAUU3m/WqorSs9UgOHYm8Cd8rIDZsswHQYDVR0OBBYEFI2MXsRUrYrhd+mb
+ZsF4bgBjWHhMA4GA1UdDwEB/wQEAwIBhjASBgNVHRMBAf8ECDAGAQH/AgEAMB0G
A1UdJQQWMBQGCCsGAQUFBwMBBggrBgEFBQcDAjAbBgNVHSAEFDASMAYGBFUdIAAw
CAYGZ4EMAQIBMFAGA1UdHwRJMEcwRaBDoEGGP2h0dHA6Ly9jcmwudXNlcnRydXN0
LmNvbS9VU0VSVHJ1c3RSU0FDZXJ0aWZpY2F0aW9uQXV0aG9yaXR5LmNybDB2Bggr
BgEFBQcBAQRqMGgwPwYIKwYBBQUHMAKGM2h0dHA6Ly9jcnQudXNlcnRydXN0LmNv
bS9VU0VSVHJ1c3RSU0FBZGRUcnVzdENBLmNydDAlBggrBgEFBQcwAYYZaHR0cDov
L29jc3AudXNlcnRydXN0LmNvbTANBgkqhkiG9w0BAQwFAAOCAgEAMr9hvQ5Iw0/H
ukdN+Jx4GQHcEx2Ab/zDcLRSmjEzmldS+zGea6TvVKqJjUAXaPgREHzSyrHxVYbH
7rM2kYb2OVG/Rr8PoLq0935JxCo2F57kaDl6r5ROVm+yezu/Coa9zcV3HAO4OLGi
H19+24rcRki2aArPsrW04jTkZ6k4Zgle0rj8nSg6F0AnwnJOKf0hPHzPE/uWLMUx
RP0T7dWbqWlod3zu4f+k+TY4CFM5ooQ0nBnzvg6s1SQ36yOoeNDT5++SR2RiOSLv
xvcRviKFxmZEJCaOEDKNyJOuB56DPi/Z+fVGjmO+wea03KbNIaiGCpXZLoUmGv38
sbZXQm2V0TP2ORQGgkE49Y9Y3IBbpNV9lXj9p5v//cWoaasm56ekBYdbqbe4oyAL
l6lFhd2zi+WJN44pDfwGF/Y4QA5C5BIG+3vzxhFoYt/jmPQT2BVPi7Fp2RBgvGQq
6jG35LWjOhSbJuMLe/0CjraZwTiXWTb2qHSihrZe68Zk6s+go/lunrotEbaGmAhY
LcmsJWTyXnW0OMGuf1pGg+pRyrbxmRE1a6Vqe8YAsOf4vmSyrcjC8azjUeqkk+B5
yOGBQMkKW+ESPMFgKuOXwIlCypTPRpgSabuY0MLTDXJLR27lk8QyKGOHQ+SwMj4K
00u/I5sUKUErmgQfky3xxzlIPK1aEn8=
-----END CERTIFICATE-----`;

/**
 * CA bundle for the VTOP HTTPS agent: Node's bundled public roots PLUS the
 * intermediate VTOP forgets to send. Scoped to VTOP so it never weakens other
 * connections, and works on every Node version (no setDefaultCACertificates).
 */
export function vtopCaBundle(): string[] {
  return [...tls.rootCertificates, SECTIGO_RSA_DV_INTERMEDIATE];
}

let applied = false;

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Node bundles its own CA list and ignores the operating-system trust store.
 * That breaks two common deployments with "unable to verify the first
 * certificate": a TLS-inspecting egress proxy (whose leaf is signed by a
 * locally-installed corporate/proxy CA) and a host that relies on a
 * system-installed intermediate. Merging the OS trust store into Node's
 * defaults restores trust without weakening verification — public CAs (VTOP's
 * real certificate) keep validating against the bundled roots. Idempotent.
 *
 * The runtime CA APIs require Node >= 22.15; on older runtimes this is a no-op
 * and trust falls back to the NODE_EXTRA_CA_CERTS environment variable.
 */
export function applySystemCATrust(): void {
  if (applied) return;
  applied = true;

  // Last-resort opt-out for hosts behind a TLS-inspecting proxy whose CA is
  // not installed in the OS trust store (so the merge below cannot help). This
  // disables certificate verification process-wide and exposes the connection
  // to interception — only enable it on a network you trust.
  if (isTruthy(process.env.VTOP_INSECURE_TLS)) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.error(
      "VtopMCP: VTOP_INSECURE_TLS is set — TLS certificate verification is DISABLED.",
    );
    return;
  }

  if (
    typeof tls.getCACertificates !== "function" ||
    typeof tls.setDefaultCACertificates !== "function"
  ) {
    return;
  }

  try {
    tls.setDefaultCACertificates([
      ...tls.getCACertificates("default"),
      ...tls.getCACertificates("system"),
    ]);
  } catch (err) {
    console.error("VtopMCP: could not merge system CA certificates:", err);
  }
}
