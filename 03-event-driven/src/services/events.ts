export const Topics = {
  OrderPlaced: 'order.placed',
  InventoryReserved: 'inventory.reserved',
  InventoryRejected: 'inventory.rejected',
  PaymentSucceeded: 'payment.succeeded',
  PaymentFailed: 'payment.failed',
  InventoryReleased: 'inventory.released',
  ShipmentCreated: 'shipment.created',
} as const;
export type Topic = (typeof Topics)[keyof typeof Topics];
export const ALL_TOPICS: Topic[] = Object.values(Topics);

export interface OrderItem {
  sku: string;
  qty: number;
  priceCents: number;
}

export type OrderStatus = 'PENDING' | 'RESERVED' | 'PAID' | 'PAYMENT_FAILED' | 'SHIPPED' | 'CANCELLED';

/** Máquina de estados monótona: un evento atrasado o repetido nunca hace retroceder un pedido. */
const RANK: Record<OrderStatus, number> = { PENDING: 0, RESERVED: 1, PAID: 2, PAYMENT_FAILED: 2, SHIPPED: 9, CANCELLED: 9 };

export function nextStatus(current: OrderStatus, topic: string): { status: OrderStatus; reason?: string } | null {
  const target: { status: OrderStatus; reason?: string } | null =
    topic === Topics.OrderPlaced ? { status: 'PENDING' }
    : topic === Topics.InventoryReserved ? { status: 'RESERVED' }
    : topic === Topics.PaymentSucceeded ? { status: 'PAID' }
    : topic === Topics.PaymentFailed ? { status: 'PAYMENT_FAILED' }
    : topic === Topics.ShipmentCreated ? { status: 'SHIPPED' }
    : topic === Topics.InventoryRejected ? { status: 'CANCELLED', reason: 'out_of_stock' }
    : topic === Topics.InventoryReleased ? { status: 'CANCELLED', reason: 'payment_failed' }
    : null;
  if (!target) return null;
  if (RANK[target.status] <= RANK[current]) return null; // atrasado o duplicado: se ignora
  if (RANK[current] === 9) return null; // estado terminal
  return target;
}
