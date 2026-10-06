import { describe, expect, it, vi } from 'vitest';
import { fcmSender, webpushFor } from './fcm-sender';

const message = { tag: 'r1', title: 'Journal', body: 'Right Now', url: '/right-now' };

describe('fcmSender', () => {
  it('sends a web push the Angular service worker shows and routes on tap', async () => {
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 2,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/internal-error' } },
      ],
    }));
    const sender = fcmSender({ sendEachForMulticast } as never);
    expect(await sender.send(['a', 'b', 'c'], message)).toEqual(['sent', 'gone', 'failed']);
    expect(sendEachForMulticast).toHaveBeenCalledWith({
      tokens: ['a', 'b', 'c'],
      webpush: webpushFor(message),
    });
  });

  it('puts the title at notification.title and the tap target in onActionClick', () => {
    const push = webpushFor(message);
    expect(push.notification).toMatchObject({
      title: 'Journal',
      tag: 'r1',
      data: {
        onActionClick: {
          default: { operation: 'navigateLastFocusedOrOpen', url: '/right-now' },
        },
      },
    });
  });
});
