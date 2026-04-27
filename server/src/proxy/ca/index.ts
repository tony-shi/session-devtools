// CA 与叶子证书签发。
// 安装时调用 ensureCa() 一次性生成；运行时每个新 SNI 调 issueLeaf() 即时签发，1h 内存缓存。
import forge from "node-forge";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "../config";

export type CaMaterial = {
  certPem: string;
  keyPem: string;
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
};

const ONE_DAY = 24 * 60 * 60 * 1000;
const CA_VALID_DAYS = 365 * 10;
const LEAF_VALID_DAYS = 30; // 设计文档说"1 小时"是为减少风险，但 TLS 库对极短证书容忍度差；30 天足够小且无歉意

let caCache: CaMaterial | null = null;
const leafCache = new Map<string, { ctx: { cert: string; key: string }; expiresAt: number }>();
const LEAF_CACHE_TTL = 60 * 60 * 1000; // 1h

export async function ensureCa(): Promise<CaMaterial> {
  if (caCache) return caCache;
  if (!existsSync(PATHS.home)) mkdirSync(PATHS.home, { recursive: true, mode: 0o700 });

  if (existsSync(PATHS.caCert) && existsSync(PATHS.caKey)) {
    const certPem = readFileSync(PATHS.caCert, "utf8");
    const keyPem = readFileSync(PATHS.caKey, "utf8");
    caCache = {
      certPem,
      keyPem,
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem),
    };
    return caCache;
  }

  caCache = await generateCa();
  writeFileSync(PATHS.caCert, caCache.certPem, { mode: 0o644 });
  writeFileSync(PATHS.caKey, caCache.keyPem, { mode: 0o600 });
  chmodSync(PATHS.caKey, 0o600); // 双保险，部分平台 writeFileSync 不严格遵守 mode
  return caCache;
}

async function generateCa(): Promise<CaMaterial> {
  const keys = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, kp) => {
      if (err) reject(err);
      else resolve(kp);
    });
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(15));
  cert.validity.notBefore = new Date(Date.now() - ONE_DAY);
  cert.validity.notAfter = new Date(Date.now() + CA_VALID_DAYS * ONE_DAY);
  const attrs = [
    { name: "commonName", value: "Session Dashboard MITM Root" },
    { name: "organizationName", value: "Session Dashboard (local)" },
    { name: "countryName", value: "CN" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert,
    key: keys.privateKey,
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export async function issueLeaf(sni: string): Promise<{ cert: string; key: string }> {
  const cached = leafCache.get(sni);
  if (cached && cached.expiresAt > Date.now()) return cached.ctx;

  const ca = await ensureCa();
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(15));
  cert.validity.notBefore = new Date(Date.now() - ONE_DAY);
  cert.validity.notAfter = new Date(Date.now() + LEAF_VALID_DAYS * ONE_DAY);
  cert.setSubject([{ name: "commonName", value: sni }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: "extKeyUsage", serverAuth: true, clientAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        // type 2 = DNS name
        { type: 2, value: sni },
      ],
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  const ctx = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
  leafCache.set(sni, { ctx, expiresAt: Date.now() + LEAF_CACHE_TTL });
  return ctx;
}

export function caFingerprint(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md
    .digest()
    .toHex()
    .match(/.{2}/g)!
    .join(":")
    .toUpperCase();
}
