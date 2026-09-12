import { connect } from "cloudflare:sockets";
import { AppError, badRequest, tooManyRequests } from "../../lib/errors";
import { base64Encode } from "../../lib/hash";
import type { MailTransport, OutboundMessage } from "../transport";
import { outboundRecipients } from "../transport";
import { serializeMime } from "./mime";

export type SmtpSecurity = "tls" | "starttls";

export interface SmtpSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  security: SmtpSecurity;
  ehloName: string;
}

export type SocketConnect = (address: SocketAddress, options?: SocketOptions) => Socket;

export interface SmtpReply {
  code: number;
  lines: string[];
}

const CRLF = "\r\n";

const encoder = new TextEncoder();

const NUL = String.fromCharCode(0);

function replyText(reply: SmtpReply): string {
  return reply.lines.join(" ").trim();
}

function rejected(reply: SmtpReply, fallback: string): AppError {
  const text = replyText(reply);
  return badRequest(text.length === 0 ? fallback : text, "message_rejected");
}

class SmtpSession {
  private socket: Socket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer: string;
  private readonly decoder: TextDecoder;

  constructor(socket: Socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.writer = socket.writable.getWriter();
    this.buffer = "";
    this.decoder = new TextDecoder();
  }

  private async readLine(): Promise<string> {
    const index = this.buffer.indexOf(CRLF);
    if (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + CRLF.length);
      return line;
    }
    const { done, value } = await this.reader.read();
    if (done) {
      throw badRequest("the SMTP server closed the connection", "message_rejected");
    }
    this.buffer += this.decoder.decode(value, { stream: true });
    return this.readLine();
  }

  private async collect(lines: string[]): Promise<SmtpReply> {
    const line = await this.readLine();
    const next = [...lines, line];
    if (line.length > 3 && line[3] === "-") {
      return this.collect(next);
    }
    return { code: Number.parseInt(line.slice(0, 3), 10), lines: next };
  }

  read(): Promise<SmtpReply> {
    return this.collect([]);
  }

  async write(payload: string): Promise<void> {
    await this.writer.write(encoder.encode(payload));
  }

  async command(line: string): Promise<SmtpReply> {
    await this.write(`${line}${CRLF}`);
    return this.read();
  }

  upgrade(): void {
    this.writer.releaseLock();
    this.reader.releaseLock();
    this.socket = this.socket.startTls();
    this.reader = this.socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.writer = this.socket.writable.getWriter();
    this.buffer = "";
  }

  async close(): Promise<void> {
    try {
      await this.socket.close();
    } catch {
      return;
    }
  }
}

function supports(reply: SmtpReply, mechanism: string): boolean {
  return reply.lines.some(
    (line) =>
      line.slice(4).toUpperCase().startsWith("AUTH") && line.toUpperCase().includes(mechanism),
  );
}

async function authenticate(
  session: SmtpSession,
  settings: SmtpSettings,
  greeting: SmtpReply,
): Promise<void> {
  if (settings.username === "") {
    return;
  }
  const reply =
    supports(greeting, "LOGIN") && !supports(greeting, "PLAIN")
      ? await loginAuth(session, settings)
      : await plainAuth(session, settings);
  if (reply.code !== 235) {
    throw new AppError(
      503,
      "sender_not_verified",
      `the SMTP server refused the credentials: ${replyText(reply)}`,
    );
  }
}

function plainAuth(session: SmtpSession, settings: SmtpSettings): Promise<SmtpReply> {
  const token = base64Encode(
    encoder.encode(`${NUL}${settings.username}${NUL}${settings.password}`),
  );
  return session.command(`AUTH PLAIN ${token}`);
}

async function loginAuth(session: SmtpSession, settings: SmtpSettings): Promise<SmtpReply> {
  const started = await session.command("AUTH LOGIN");
  if (started.code !== 334) {
    return started;
  }
  const user = await session.command(base64Encode(encoder.encode(settings.username)));
  if (user.code !== 334) {
    return user;
  }
  return session.command(base64Encode(encoder.encode(settings.password)));
}

function dotStuff(raw: string): string {
  return raw.startsWith(".")
    ? `.${raw.replace(/\r\n\./g, `${CRLF}..`)}`
    : raw.replace(/\r\n\./g, `${CRLF}..`);
}

async function greet(session: SmtpSession, settings: SmtpSettings): Promise<SmtpReply> {
  const reply = await session.command(`EHLO ${settings.ehloName}`);
  if (reply.code !== 250) {
    throw rejected(reply, "the SMTP server refused EHLO");
  }
  return reply;
}

async function startSession(session: SmtpSession, settings: SmtpSettings): Promise<SmtpReply> {
  const greeting = await session.read();
  if (greeting.code !== 220) {
    throw rejected(greeting, "the SMTP server refused the connection");
  }
  const first = await greet(session, settings);
  if (settings.security !== "starttls") {
    return first;
  }
  const upgraded = await session.command("STARTTLS");
  if (upgraded.code !== 220) {
    throw rejected(upgraded, "the SMTP server refused STARTTLS");
  }
  session.upgrade();
  return greet(session, settings);
}

async function envelope(session: SmtpSession, message: OutboundMessage): Promise<void> {
  const sender = await session.command(`MAIL FROM:<${message.from.email}>`);
  if (sender.code >= 500) {
    throw new AppError(
      503,
      "sender_not_verified",
      `the SMTP server refused the sender: ${replyText(sender)}`,
    );
  }
  if (sender.code >= 400) {
    throw tooManyRequests(`the SMTP server deferred the sender: ${replyText(sender)}`);
  }
  for (const recipient of outboundRecipients(message)) {
    const reply = await session.command(`RCPT TO:<${recipient}>`);
    if (reply.code >= 500) {
      throw badRequest(
        `${recipient} was refused by the SMTP server: ${replyText(reply)}`,
        "recipient_suppressed",
      );
    }
    if (reply.code >= 400) {
      throw tooManyRequests(`${recipient} was deferred by the SMTP server: ${replyText(reply)}`);
    }
  }
}

async function transmit(session: SmtpSession, raw: string): Promise<void> {
  const started = await session.command("DATA");
  if (started.code !== 354) {
    throw rejected(started, "the SMTP server refused DATA");
  }
  await session.write(`${dotStuff(raw)}${CRLF}.${CRLF}`);
  const accepted = await session.read();
  if (accepted.code !== 250) {
    throw rejected(accepted, "the SMTP server rejected the message");
  }
}

async function deliver(
  settings: SmtpSettings,
  socket: Socket,
  message: OutboundMessage,
): Promise<string> {
  const session = new SmtpSession(socket);
  try {
    const greeting = await startSession(session, settings);
    await authenticate(session, settings, greeting);
    await envelope(session, message);
    const serialized = serializeMime(message);
    await transmit(session, new TextDecoder().decode(serialized.raw));
    await session.command("QUIT");
    return serialized.messageId;
  } finally {
    await session.close();
  }
}

export function smtpTransport(
  settings: SmtpSettings,
  open: SocketConnect = connect,
): MailTransport {
  return {
    send: (message: OutboundMessage): Promise<string | null> =>
      deliver(
        settings,
        open(
          { hostname: settings.host, port: settings.port },
          {
            secureTransport: settings.security === "tls" ? "on" : "starttls",
            allowHalfOpen: false,
          },
        ),
        message,
      ),
  };
}
