import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';

/**
 * pnpm list whatsapp-web.js puppeteer
 * delete message.__x_id;
 * npm install --save-dev patch-package
 * {
 *   "scripts": {
 *     "postinstall": "patch-package"
 *   }
 * }
 * open node_modules/whatsapp-web.js/src/util/Injected/Utils.js
 * const message = {
 *     ...msg,
 *     ...mediaOptions,
 *     ...extraOptions,
 * };
 *
 * // MediaData has an internal __x_id that can overwrite Msg's real id.
 * delete message.__x_id;
 *
 * // Bot's won't reply if canonicalUrl is set (linking)
 * if (botOptions) {
 *     delete message.canonicalUrl;
 * }
 * //generate patch
 * npx patch-package whatsapp-web.js
 * npm run start
 *
 * design the whatsapp service
 *                     ┌──────────────┐
 *                     │  INITIALIZE  │
 *                     └──────┬───────┘
 *                            │
 *                            ▼
 *                     ┌──────────────┐
 *                     │     READY    │
 *                     └──────┬───────┘
 *                            │
 *              ┌─────────────┴──────────────┐
 *              │                            │
 *              ▼                            ▼
 *        disconnected                 detached Frame
 *              │                            │
 *              └─────────────┬──────────────┘
 *                            ▼
 *                     ┌──────────────┐
 *                     │   RECOVERY   │
 *                     └──────┬───────┘
 *                            │
 *                     destroy old client
 *                            │
 *                     create new client
 *                            │
 *                     initialize LocalAuth
 *                            │
 *                            ▼
 *                          READY
 */
@Injectable()
export class WhatsappService implements OnModuleInit, OnApplicationShutdown {
  private client: Client | null = null;

  private ready = false;
  private initializing = false;
  private reconnecting = false;
  private shuttingDown = false;

  private readonly logger = new Logger(WhatsappService.name);

  private readonly CLIENT_ID = 'auto-whatsapp-bot';
  private readonly RECONNECT_DELAY = 5_000;
  private readonly READY_TIMEOUT = 30_000;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  async onModuleInit(): Promise<void> {
    await this.initializeClient();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;

    this.logger.log(
      `Shutting down WhatsApp client. Signal: ${signal ?? 'unknown'}`,
    );

    await this.destroyClient();
  }

  // ---------------------------------------------------------------------------
  // Client creation
  // ---------------------------------------------------------------------------
  private createClient(): Client {
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.CLIENT_ID,
      }),

      puppeteer: {
        headless: true,

        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--no-zygote',
        ],
      },

      webVersionCache: {
        type: 'local',
        path: './.wwebjs_cache',
      },
    });

    this.registerEventHandlers(client);

    return client;
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------
  private registerEventHandlers(client: Client): void {
    client.on('qr', (qr) => {
      this.logger.log('📱 WhatsApp QR code received');

      qrcode.generate(qr, {
        small: true,
      });
    });

    client.on('authenticated', () => {
      this.logger.log('🔐 WhatsApp authenticated');
    });

    client.on('ready', () => {
      this.ready = true;

      this.logger.log('🙏 WhatsApp client ready');
    });

    client.on('auth_failure', (message) => {
      this.ready = false;

      this.logger.error(`❌ WhatsApp authentication failure: ${message}`);
    });

    client.on('change_state', (state) => {
      this.logger.warn(`🔄 WhatsApp state changed: ${state}`);
    });

    /*client.on('loading_screen', (percent, message) => {
      this.logger.debug(`⏳ WhatsApp loading: ${percent}% - ${message}`);
    });*/

    client.on('disconnected', (reason) => {
      this.ready = false;

      this.logger.error(`❌ WhatsApp disconnected: ${reason}`);

      if (!this.shuttingDown) {
        void this.recoverClient(`disconnected: ${reason}`);
      }
    });

    client.on('message_ack', (message, ack) => {
      if (ack === 1) {
        this.logger.log(
          `Confirmed message sent: "${message.body.substring(0, 20)}..."`,
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  private async initializeClient(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    if (this.initializing) {
      this.logger.debug('WhatsApp client initialization already in progress');

      return;
    }

    if (this.client && this.ready) {
      return;
    }

    this.initializing = true;

    const client = this.createClient();

    this.client = client;

    try {
      this.logger.log('Initializing WhatsApp client...');

      await client.initialize();

      // Make sure an old client didn't finish initializing
      // after another client had already replaced it.
      if (this.client !== client) {
        this.logger.warn(
          'Ignoring initialization result from stale WhatsApp client',
        );

        return;
      }

      this.logger.log('WhatsApp client initialization completed');
    } catch (error) {
      if (this.client === client) {
        this.client = null;
        this.ready = false;
      }

      this.logger.error(
        'WhatsApp client initialization failed',
        this.getErrorStack(error),
      );

      throw error;
    } finally {
      this.initializing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Readiness
  // ---------------------------------------------------------------------------
  async ensureReady(): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('WhatsApp service is shutting down');
    }

    if (this.ready && this.client) {
      return;
    }

    if (!this.client) {
      await this.initializeClient();
    }

    if (this.ready) {
      return;
    }

    await this.waitForReady();
  }

  private async waitForReady(): Promise<void> {
    const client = this.client;

    if (!client) {
      throw new Error('WhatsApp client is not initialized');
    }

    if (this.ready) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);

        client.off('ready', onReady);
        client.off('auth_failure', onAuthFailure);
        client.off('disconnected', onDisconnected);
      };

      const resolveOnce = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        this.ready = true;

        resolve();
      };

      const rejectOnce = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        reject(error);
      };

      const onReady = () => {
        resolveOnce();
      };

      const onAuthFailure = (message: string) => {
        rejectOnce(new Error(`WhatsApp authentication failure: ${message}`));
      };

      const onDisconnected = (reason: string) => {
        rejectOnce(
          new Error(`WhatsApp disconnected while waiting for ready: ${reason}`),
        );
      };

      const timeout = setTimeout(() => {
        rejectOnce(
          new Error(
            `WhatsApp client did not become ready within ${
              this.READY_TIMEOUT / 1000
            } seconds`,
          ),
        );
      }, this.READY_TIMEOUT);

      client.once('ready', onReady);
      client.once('auth_failure', onAuthFailure);
      client.once('disconnected', onDisconnected);
    });
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------
  private async recoverClient(reason: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    if (this.reconnecting) {
      this.logger.warn(`Recovery already in progress. Reason: ${reason}`);

      return;
    }

    this.reconnecting = true;
    this.ready = false;

    try {
      this.logger.warn(`🔄 Starting WhatsApp recovery. Reason: ${reason}`);

      for (let attempt = 1; attempt <= this.MAX_RECONNECT_ATTEMPTS; attempt++) {
        if (this.shuttingDown) {
          return;
        }

        this.logger.warn(
          `Reconnect attempt ${attempt}/${this.MAX_RECONNECT_ATTEMPTS}`,
        );

        try {
          await this.destroyClient();

          await this.delay(this.RECONNECT_DELAY);

          await this.initializeClient();

          await this.waitForReady();

          this.logger.log('✅ WhatsApp client successfully recovered');

          return;
        } catch (error) {
          this.ready = false;

          this.logger.error(
            `Reconnect attempt ${attempt} failed`,
            this.getErrorStack(error),
          );
        }
      }

      this.logger.error(
        `❌ WhatsApp recovery failed after ${this.MAX_RECONNECT_ATTEMPTS} attempts`,
      );
    } finally {
      this.reconnecting = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------
  async sendSingleGroupMessage(
    groupId: string | undefined,
    imageBuffer: Buffer,
    caption: string,
  ): Promise<void> {
    if (!groupId) {
      throw new Error('WHATSAPP_GROUP_ID is undefined');
    }

    try {
      await this.ensureReady();

      const client = this.client;

      if (!client || !this.ready) {
        throw new Error('WhatsApp client is not ready');
      }

      const media = new MessageMedia(
        'image/jpeg',
        imageBuffer.toString('base64'),
        'devotional.jpg',
      );

      await client.sendMessage(groupId, media, {
        caption,
        sendSeen: false,
      });

      this.logger.log('📤 Devotional sent successfully');
    } catch (error) {
      const message = this.getErrorMessage(error);

      if (this.isDetachedFrameError(message)) {
        this.logger.error(
          '❌ WhatsApp Web frame detached. Starting client recovery.',
        );

        this.ready = false;

        await this.recoverClient('detached frame during sendMessage');

        // Retry the actual message after successful recovery.
        await this.sendSingleGroupMessage(groupId, imageBuffer, caption);

        return;
      }

      this.logger.error(`WhatsApp Messaging failed: ${message}`);

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------------
  async getGroupsByName(): Promise<void> {
    await this.ensureReady();

    if (!this.client) {
      throw new Error('WhatsApp client is unavailable');
    }

    const chats = await this.client.getChats();

    const groups = chats.filter((chat) => chat.isGroup);

    groups.forEach((group) => {
      this.logger.log({
        name: group.name,
        id: group.id._serialized,
      });
    });
  }

  async getGroupById(groupName: string): Promise<string | null> {
    await this.ensureReady();

    if (!this.client) {
      throw new Error('WhatsApp client is unavailable');
    }

    const chats = await this.client.getChats();

    const group = chats.find((chat) => chat.isGroup && chat.name === groupName);

    if (!group) {
      this.logger.warn(`WhatsApp group not found: ${groupName}`);

      return null;
    }

    return group.id._serialized;
  }

  // ---------------------------------------------------------------------------
  // Destruction
  // ---------------------------------------------------------------------------
  async destroyClient(): Promise<void> {
    const client = this.client;

    this.client = null;
    this.ready = false;

    if (!client) {
      return;
    }

    try {
      this.logger.log('Destroying WhatsApp client...');

      await client.destroy();

      this.logger.log('WhatsApp client destroyed successfully');
    } catch (error) {
      this.logger.error(
        'Error destroying WhatsApp client',
        this.getErrorStack(error),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private isDetachedFrameError(message: string): boolean {
    return (
      message.includes('Attempted to use detached Frame') ||
      message.includes('Attempted to use detached frame')
    );
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private getErrorStack(error: unknown): string {
    if (error instanceof Error) {
      return error.stack ?? error.message;
    }

    return String(error);
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
