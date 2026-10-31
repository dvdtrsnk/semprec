import type { BlobStorageWriter } from "../mail/blobStorage.js";
import type { MailTransport, MailTransportFactory, MailTransportMessage } from "../mail/mailTransport.js";
import type { MailSendAdapterFactory } from "../mail/send.js";

/** A transport that records every message it is asked to send; `overrides` replaces members such as `send`. */
export interface RecordingTransport extends MailTransport {
  readonly sent: MailTransportMessage[];
}

export function recordingTransport(overrides: Partial<MailTransport> = {}): RecordingTransport {
  const sent: MailTransportMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return {};
    },
    ...overrides,
  };
}

/** A transport factory that hands the same transport to every mailbox. */
export function transportFor(transport: MailTransport): MailTransportFactory {
  return { forMailbox: async () => transport };
}

const UNUSED_STORAGE = "the send tests attach no files, so the attachment storage is never read";

/** Attachment storage for tests whose messages carry no attachment: the MIME builder reads it only for a blob part. */
const unusedStorage: BlobStorageWriter = {
  writeStream: () => Promise.reject(new Error(UNUSED_STORAGE)),
  delete: () => Promise.reject(new Error(UNUSED_STORAGE)),
  readStream: () => {
    throw new Error(UNUSED_STORAGE);
  },
};

/** The adapters `sendDraftEmail` takes in a test: the given transports, and attachment storage no test reads. */
export function sendAdapters(transports: MailTransportFactory): MailSendAdapterFactory {
  return { transports, attachmentStorage: { files: unusedStorage, mailAttachments: unusedStorage } };
}
