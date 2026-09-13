/**
 * Order access to a real Deribit account.
 *
 *   testnet  Deribit's test exchange: fake money, but the real API and matching
 *            engine, and every order and trade shows in the test account
 *   live     real money; the bot refuses this mode unless Ivan unlocks it himself
 *
 * Every order is a post-only LIMIT order: it rests on the book as a maker and never
 * crosses the spread. If its price would match immediately, Deribit moves it to
 * just inside the spread rather than letting it pay the other side. Every order
 * carries a label, so it can be found again after a timeout or a restart.
 */
import { MAINNET, TESTNET } from './deribit.ts';

export type Side = 'buy' | 'sell';

export type OrderView = {
  orderId: string;
  instrument: string;
  side: Side;
  /** Limit price, quote currency (coin for inverse books, USDC for linear). */
  price: number;
  amount: number;
  filled: number;
  /** Average fill price, quote currency; 0 until something fills. */
  avgPrice: number;
  /** open, filled, cancelled, rejected. */
  state: string;
  label: string;
};

export type PositionView = {
  instrument: string;
  /** Signed: positive long, negative short. */
  size: number;
  averagePrice: number;
  averagePriceUsd: number;
  markPrice: number;
  floatingPnlUsd: number;
  delta: number;
};

export type AccountView = { currency: string; equity: number; availableFunds: number; initialMargin: number; maintenanceMargin: number; marginModel: string };

export interface Broker {
  readonly mode: 'testnet' | 'live';
  readonly base: string;
  limitOrder(side: Side, instrument: string, amount: number, price: number, label: string, currency: string): Promise<OrderView>;
  /** Margin Deribit would require to buy or sell `amount` at `price`, in the settlement currency. */
  margins(instrument: string, amount: number, price: number): Promise<{ buy: number; sell: number }>;
  /** Move a resting order to a new price, keeping its size. */
  editOrder(order: OrderView, price: number): Promise<OrderView>;
  cancelOrder(orderId: string): Promise<OrderView>;
  orderState(orderId: string): Promise<OrderView>;
  /** The most recent order under this label, if the exchange has one. */
  orderByLabel(label: string, currency: string): Promise<OrderView | null>;
  positions(currency: string): Promise<PositionView[]>;
  accounts(): Promise<AccountView[]>;
}

export class DeribitError extends Error {
  status: number;
  constructor(method: string, status: number, error: any) {
    // Never include the request URL: the auth request carries the client secret.
    super(`Deribit ${method}: ${error?.message ?? `HTTP ${status}`}${error?.data?.reason ? ` (${error.data.reason})` : ''}`);
    this.status = status;
  }
}

function toOrder(o: any): OrderView {
  return {
    orderId: String(o.order_id),
    instrument: String(o.instrument_name),
    side: o.direction,
    price: Number(o.price) || 0,
    amount: Number(o.amount) || 0,
    filled: Number(o.filled_amount) || 0,
    avgPrice: Number(o.average_price) || 0,
    state: String(o.order_state),
    label: String(o.label ?? ''),
  };
}

export class DeribitBroker implements Broker {
  readonly mode: 'testnet' | 'live';
  readonly base: string;
  #id: string;
  #secret: string;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(mode: 'testnet' | 'live', clientId: string, clientSecret: string) {
    this.mode = mode;
    this.base = mode === 'live' ? MAINNET : TESTNET;
    this.#id = clientId;
    this.#secret = clientSecret;
  }

  async #call(method: string, params: Record<string, string>, auth = true): Promise<any> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth) headers.Authorization = `Bearer ${await this.#accessToken()}`;
    const res = await fetch(`${this.base}/${method}?${new URLSearchParams(params)}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json || json.error) throw new DeribitError(method, res.status, json?.error);
    return json.result;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#token.expiresAt - 60_000) return this.#token.value;
    const r = await this.#call('public/auth', {
      grant_type: 'client_credentials',
      client_id: this.#id,
      client_secret: this.#secret,
    }, false);
    this.#token = { value: r.access_token, expiresAt: Date.now() + Number(r.expires_in) * 1000 };
    return this.#token.value;
  }

  async limitOrder(side: Side, instrument: string, amount: number, price: number, label: string, currency: string): Promise<OrderView> {
    try {
      const r = await this.#call(`private/${side}`, {
        instrument_name: instrument,
        amount: String(amount),
        type: 'limit',
        price: String(price),
        time_in_force: 'good_til_cancelled',
        post_only: 'true',
        reject_post_only: 'false',
        label,
      });
      return toOrder(r.order);
    } catch (e) {
      // The exchange answered and refused: nothing was placed.
      if (e instanceof DeribitError && e.status >= 400 && e.status < 500) throw e;
      // No clear answer. The order may still exist, so find it by label before
      // anyone decides what to do next; a blind retry could place it twice.
      const found = await this.orderByLabel(label, currency).catch(() => null);
      if (found) return found;
      throw new Error(`${side} ${instrument}: no response and no order under label ${label}; check Deribit before retrying`);
    }
  }

  async editOrder(order: OrderView, price: number): Promise<OrderView> {
    try {
      const r = await this.#call('private/edit', {
        order_id: order.orderId,
        amount: String(order.amount),
        price: String(price),
        post_only: 'true',
      });
      return toOrder(r.order);
    } catch (e) {
      // Usually the order filled or was cancelled in the meantime; report what it is now.
      if (e instanceof DeribitError && e.status >= 400 && e.status < 500) return this.orderState(order.orderId);
      throw e;
    }
  }

  async cancelOrder(orderId: string): Promise<OrderView> {
    try {
      return toOrder(await this.#call('private/cancel', { order_id: orderId }));
    } catch (e) {
      if (e instanceof DeribitError && e.status >= 400 && e.status < 500) return this.orderState(orderId);
      throw e;
    }
  }

  async orderState(orderId: string): Promise<OrderView> {
    return toOrder(await this.#call('private/get_order_state', { order_id: orderId }));
  }

  async orderByLabel(label: string, currency: string): Promise<OrderView | null> {
    const rows: any[] = await this.#call('private/get_order_state_by_label', { currency, label });
    return Array.isArray(rows) && rows.length ? toOrder(rows[0]) : null;
  }

  async positions(currency: string): Promise<PositionView[]> {
    const rows: any[] = await this.#call('private/get_positions', { currency, kind: 'option' });
    return rows
      .filter((r) => Number(r.size) && r.direction !== 'zero')
      .map((r) => ({
        instrument: String(r.instrument_name),
        size: r.direction === 'sell' ? -Math.abs(Number(r.size)) : Math.abs(Number(r.size)),
        averagePrice: Number(r.average_price) || 0,
        averagePriceUsd: Number(r.average_price_usd) || 0,
        markPrice: Number(r.mark_price) || 0,
        floatingPnlUsd: Number(r.floating_profit_loss_usd) || 0,
        delta: Number(r.delta) || 0,
      }));
  }

  async margins(instrument: string, amount: number, price: number): Promise<{ buy: number; sell: number }> {
    const r = await this.#call('private/get_margins', { instrument_name: instrument, amount: String(amount), price: String(price) });
    return { buy: Number(r.buy) || 0, sell: Number(r.sell) || 0 };
  }

  async accounts(): Promise<AccountView[]> {
    const r = await this.#call('private/get_account_summaries', {});
    return (r.summaries ?? []).map((s: any) => ({
      currency: String(s.currency),
      equity: Number(s.equity) || 0,
      availableFunds: Number(s.available_funds) || 0,
      initialMargin: Number(s.initial_margin) || 0,
      maintenanceMargin: Number(s.maintenance_margin) || 0,
      marginModel: String(s.margin_model ?? ''),
    }));
  }
}
