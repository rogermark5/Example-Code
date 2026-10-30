
type Brand<T, K extends string> = T & { readonly __brand: K };

type PaymentId = Brand<string, "PaymentId">;
type CustomerId = Brand<string, "CustomerId">;

type Money = Readonly<{
  cents: number;
  currency: "USD" | "EUR";
}>;

type PaymentRequest = Readonly<{
  key: string;
  customerId: CustomerId;
  amount: Money;
}>;

type PaymentResult =
  | { status: "succeeded"; paymentId: PaymentId }
  | { status: "declined"; reason: string };

type ClaimResult =
  | { kind: "acquired" }
  | { kind: "busy" }
  | { kind: "done"; result: PaymentResult }
  | { kind: "conflict" };

interface PaymentStore {
  claim(key: string, hash: string): Promise<ClaimResult>;
  complete(key: string, result: PaymentResult): Promise<void>;
}

interface PaymentGateway {
  charge(
    request: PaymentRequest,
    options: { idempotencyKey: string; signal?: AbortSignal }
  ): Promise<PaymentResult>;
}

class PaymentService {
  constructor(
    private readonly store: PaymentStore,
    private readonly gateway: PaymentGateway
  ) {}

  async charge(
    request: PaymentRequest,
    signal?: AbortSignal
  ): Promise<PaymentResult> {
    const { key, amount } = request;

    if (!key.trim()) throw new Error("Missing payment key");

    if (!Number.isSafeInteger(amount.cents) || amount.cents <= 0) {
      throw new RangeError("Bad amount");
    }

    const hash = await this.hashRequest(request);
    const claim = await this.store.claim(key, hash);

    switch (claim.kind) {
      case "done":
        return claim.result;

      case "busy":
        throw new Error("Payment's already running");

      case "conflict":
        throw new Error("Same key, different payment");

      case "acquired":
        break;

      default:
        return assertNever(claim);
    }

    // don't retry blindly here. timeout doesn't mean no charge
    const result = await this.gateway.charge(request, {
      idempotencyKey: key,
      signal
    });

    // if this fails, leave it pending. reconcile later
    await this.store.complete(key, result);

    return result;
  }

  private async hashRequest(request: PaymentRequest): Promise<string> {
    const data = JSON.stringify([
      request.customerId,
      request.amount.cents,
      request.amount.currency
    ]);

    const bytes = new TextEncoder().encode(data);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)]
      .map(x => x.toString(16).padStart(2, "0"))
      .join("");
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected payment state: ${JSON.stringify(value)}`);
}
