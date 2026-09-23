import { readFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { OpenOptions } from './types.js';

const CONNECT_TIMEOUT = 30_000;

// Owns only jump SSH connections and the single final loopback bridge.
export class Transport {
  private clients: Client[] = [];
  private channels: ClientChannel[] = [];
  private clientClosures: Promise<void>[] = [];
  private server?: Server;
  private socket?: Socket;
  private closed = false;
  private failure?: Error;
  private pending = new Set<(error: Error) => void>();

  constructor(private readonly onFailure: (error: Error) => void) {}

  private fail(error: Error): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    for (const reject of this.pending) reject(error);
    this.onFailure(error);
    void this.close();
  }

  private wait<T>(start: (resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed || this.failure) return reject(this.failure ?? new Error('Transport is closed'));
      const fail = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => fail(new Error('SSH forwarding timed out')), CONNECT_TIMEOUT);
      const cleanup = () => { clearTimeout(timer); this.pending.delete(fail); };
      this.pending.add(fail);
      try { start(value => { cleanup(); resolve(value); }, fail); }
      catch (error) { fail(error as Error); }
    });
  }

  private async forward(client: Client, host: string, port: number): Promise<ClientChannel> {
    return this.wait((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
        if (error) return reject(new Error(`Cannot forward to ${host}:${port}: ${error.message}`));
        if (this.closed) { channel.destroy(); return; }
        this.channels.push(channel);
        channel.on('error', (error: Error) => this.fail(error));
        channel.on('close', () => this.fail(new Error(`Forwarding to ${host}:${port} closed`)));
        resolve(channel);
      });
    });
  }

  async open({ board, jumps = [] }: OpenOptions): Promise<{ host: string; port: number }> {
    let previous: Client | undefined;
    for (const jump of jumps) {
      const privateKey = jump.privateKeyFile ? await readFile(jump.privateKeyFile) : undefined;
      const sock = previous ? await this.forward(previous, jump.host, jump.port ?? 22) : undefined;
      if (this.closed) throw this.failure ?? new Error('Transport is closed');
      const client = new Client();
      this.clients.push(client);
      let connectionClosed!: () => void;
      this.clientClosures.push(new Promise(resolve => {
        connectionClosed = resolve;
        client.once('close', resolve);
      }));
      client.on('error', error => this.fail(new Error(`Jump ${jump.host}: ${error.message}`)));
      client.on('close', () => this.fail(new Error(`Jump ${jump.host} closed`)));
      const config: ConnectConfig = {
        host: jump.host, port: jump.port ?? 22, username: jump.username,
        ...(privateKey ? { privateKey } : { password: jump.password }),
        sock, readyTimeout: CONNECT_TIMEOUT, keepaliveInterval: 30_000, keepaliveCountMax: 3,
      };
      await this.wait<void>(resolve => {
        client.once('ready', resolve);
        try { client.connect(config); }
        catch (error) {
          // Invalid key/config can throw before ssh2 creates a socket. In that
          // case destroy() has no socket and will never emit a close event.
          client.destroy();
          connectionClosed();
          throw error;
        }
      });
      previous = client;
    }
    if (!previous) return { host: board.host, port: board.port ?? 22 };

    const channel = await this.forward(previous, board.host, board.port ?? 22);
    const server = this.server = createServer(socket => {
      if (this.socket || this.closed) { socket.destroy(); return; }
      this.socket = socket;
      server.close(); // Stop listening; the accepted socket remains owned until close().
      socket.setNoDelay(true);
      socket.on('error', error => this.fail(error));
      socket.on('close', () => this.fail(new Error('Board TCP bridge closed')));
      socket.pipe(channel).pipe(socket);
    });
    server.on('error', error => this.fail(error));
    await this.wait<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback bridge did not start');
    return { host: '127.0.0.1', port: address.port };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const reject of this.pending) reject(this.failure ?? new Error('Transport closed'));
    this.socket?.destroy();
    const closing: Promise<void>[] = [];
    if (this.server?.listening) {
      closing.push(new Promise(resolve => this.server!.close(() => resolve())));
    }
    for (const channel of this.channels.reverse()) channel.destroy();
    for (const client of this.clients.reverse()) client.destroy();
    closing.push(...this.clientClosures);
    await Promise.all(closing);
  }
}
