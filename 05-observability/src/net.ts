import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export class UnsafeTargetError extends Error {}

/** ¿Es una IP privada / loopback / link-local / metadatos de cloud / multicast? (IPv4 e IPv6, incl. IPv4 mapeada). */
export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, incluye 169.254.169.254 (metadatos AWS/GCP/Azure)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast y reservado
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]!);
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16);
      const lo = parseInt(hexMapped[2]!, 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
  }
  return true; // lo que no es una IP válida no se considera seguro
}

export type SafeFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

/**
 * fetch con protección SSRF: un monitor o un webhook configurado por un usuario NO puede apuntar a la red interna
 * (127.0.0.1, 10.x, 169.254.169.254...).
 *
 * La comprobación se hace EN EL MOMENTO DE CONECTAR (dentro del `lookup` del socket), no antes: validar el DNS y luego
 * dejar que el cliente lo resuelva otra vez permite "DNS rebinding" (la 1ª respuesta es pública, la 2ª es 127.0.0.1).
 * Las IP literales no pasan por el DNS, así que se validan antes. No se siguen redirecciones (otra vía clásica de SSRF).
 */
export function createSafeFetch(allowPrivate: boolean): SafeFetch {
  const agent = new Agent({
    connect: {
      lookup: (hostname: string, options: any, cb: any) => {
        dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return cb(err);
          const list = addresses as unknown as Array<{ address: string; family: number }>;
          if (!allowPrivate) {
            const bad = list.find((a) => isPrivateIp(a.address));
            if (bad) return cb(new UnsafeTargetError(`blocked address ${bad.address} for host ${hostname}`));
          }
          if (options?.all) return cb(null, list);
          cb(null, list[0]!.address, list[0]!.family);
        });
      },
    },
  });

  return async (url, init = {}) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new UnsafeTargetError('invalid URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeTargetError('only http(s) URLs are allowed');
    if (u.username || u.password) throw new UnsafeTargetError('credentials in URL are not allowed');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) throw new UnsafeTargetError(`blocked address ${host}`);
    if (!allowPrivate && /^localhost$/i.test(host)) throw new UnsafeTargetError('blocked host localhost');

    let res;
    try {
      res = await undiciFetch(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
        redirect: 'manual',
        dispatcher: agent,
        signal: AbortSignal.timeout(init.timeoutMs ?? 5000),
      });
    } catch (e) {
      // undici envuelve los fallos de conexión en un genérico "fetch failed": exponemos la causa real si fue el bloqueo.
      if ((e as any)?.cause instanceof UnsafeTargetError) throw (e as any).cause;
      throw e;
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 400, text: () => res.text() };
  };
}

/** Valida una URL de destino al CONFIGURARLA (feedback inmediato al usuario; la defensa real está en el connect). */
export function assertSafeUrlShape(url: string, allowPrivate: boolean): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UnsafeTargetError('invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeTargetError('only http(s) URLs are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && ((net.isIP(host) && isPrivateIp(host)) || /^localhost$/i.test(host))) throw new UnsafeTargetError('target address is not allowed');
}
