import type { BillingProvider } from './provider.js';

/**
 * Proveedor de desarrollo: no llama a ningún servicio externo. El frontend muestra un
 * "pago simulado" que dispara el MISMO procesador de eventos que usa el webhook real.
 */
export function createFakeProvider(webOrigin: string): BillingProvider {
  return {
    kind: 'fake',
    async createCheckout(i) {
      return { url: `${webOrigin}/billing?fake_checkout=${i.plan}` };
    },
    async createPortal({ returnUrl }) {
      return { url: `${returnUrl}?fake_portal=1` };
    },
  };
}
