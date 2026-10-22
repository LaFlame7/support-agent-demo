import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface OutboundReply {
  idempotencyKey: string;
  channel: string;
  ticketExternalId: string;
  body: string;
}

/**
 * The outside world. Most helpdesks and mail servers don't dedupe on a key we
 * choose, so the adapter must be able to answer "did this key already go out?".
 * Zendesk: keep the key in comment metadata. Email: derive the Message-ID from it.
 */
export interface ChannelAdapter {
  send(reply: OutboundReply): Promise<{ providerMessageId: string }>;
  findByIdempotencyKey(key: string): Promise<{ providerMessageId: string } | null>;
}

/**
 * Stand-in helpdesk with no idempotency of its own: a second send is a second reply.
 * Pass a file to keep its history across worker restarts.
 */
export class FakeHelpdesk implements ChannelAdapter {
  readonly sent: (OutboundReply & { providerMessageId: string })[];
  private failuresLeft = 0;

  constructor(private readonly file?: string) {
    if (file) mkdirSync(dirname(file), { recursive: true });
    this.sent = file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }

  failNextSends(n: number) {
    this.failuresLeft = n;
  }

  async send(reply: OutboundReply) {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error("helpdesk returned 503");
    }
    const message = { ...reply, providerMessageId: `hd_${this.sent.length + 1}` };
    if (this.file) appendFileSync(this.file, `${JSON.stringify(message)}\n`);
    this.sent.push(message);
    return { providerMessageId: message.providerMessageId };
  }

  async findByIdempotencyKey(key: string) {
    const found = this.sent.find((m) => m.idempotencyKey === key);
    return found ? { providerMessageId: found.providerMessageId } : null;
  }
}
