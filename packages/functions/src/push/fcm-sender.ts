import type { Messaging, WebpushConfig } from 'firebase-admin/messaging';
import type { PushMessage, PushSender, SendResult } from './send-due';

/** FCM error codes meaning the token is dead and its device can go. */
const GONE = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * The web push for a message. The app's Angular service worker shows it
 * (it shows any push whose JSON has `notification.title`) and handles
 * the tap through `data.onActionClick`, so the app needs no Firebase
 * messaging service worker of its own.
 */
export function webpushFor(m: PushMessage): WebpushConfig {
  return {
    headers: { Urgency: 'high', TTL: String(60 * 60) },
    notification: {
      title: m.title,
      body: m.body,
      tag: m.tag,
      renotify: true,
      icon: '/icons/icon-192.png',
      data: {
        onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: m.url } },
      },
    },
  };
}

export function fcmSender(messaging: Pick<Messaging, 'sendEachForMulticast'>): PushSender {
  return {
    async send(tokens, m) {
      const res = await messaging.sendEachForMulticast({ tokens, webpush: webpushFor(m) });
      return res.responses.map((r): SendResult => {
        if (r.success) return 'sent';
        return GONE.has(r.error?.code ?? '') ? 'gone' : 'failed';
      });
    },
  };
}
