import { describe, expect, it, vi } from 'vitest';
import {
  BATCH,
  type Device,
  type DueReminder,
  type PushStore,
  type SendResult,
  messageFor,
  sendDue,
} from './send-due';

const NY = 'America/New_York';
const now = Date.parse('2026-10-06T13:00:30Z'); // Tue 09:00:30 NY

function reminder(over: Partial<DueReminder> = {}): DueReminder {
  return {
    uid: 'u1',
    id: 'r1',
    text: 'Call the bank',
    status: 'open',
    dueAt: Date.parse('2026-10-06T13:00:00Z'),
    nextFireAt: Date.parse('2026-10-06T13:00:00Z'),
    ...over,
  };
}

function fakes(due: DueReminder[], devices: Record<string, Device[]>, results?: SendResult[]) {
  const store = {
    due: vi.fn(async () => due),
    claim: vi.fn(async (_r: DueReminder, _expected: number, _next: number | undefined) => true),
    devices: vi.fn(async (uid: string) => devices[uid] ?? []),
    removeDevice: vi.fn(async (_uid: string, _id: string) => undefined),
  } satisfies PushStore;
  const sender = {
    send: vi.fn(async (tokens: string[]) => results ?? tokens.map((): SendResult => 'sent')),
  };
  return { store, sender };
}

describe('sendDue', () => {
  it('claims a due one-off, clearing its push time, and pushes it to every device', async () => {
    const r = reminder();
    const { store, sender } = fakes([r], {
      u1: [
        { id: 'd1', token: 't1' },
        { id: 'd2', token: 't2' },
      ],
    });
    const report = await sendDue(store, sender, now);
    expect(store.due).toHaveBeenCalledWith(now, BATCH);
    expect(store.claim).toHaveBeenCalledWith(r, r.nextFireAt, undefined);
    expect(sender.send).toHaveBeenCalledWith(['t1', 't2'], messageFor(r));
    expect(report).toEqual({ claimed: 1, sent: 2, failed: 0, removedDevices: 0 });
  });

  it('moves a repeat on to its next occurrence', async () => {
    const r = reminder({ recurrence: { freq: 'daily', time: '09:00', tz: NY } });
    const { store, sender } = fakes([r], {});
    await sendDue(store, sender, now);
    expect(store.claim).toHaveBeenCalledWith(r, r.nextFireAt, Date.parse('2026-10-07T13:00:00Z'));
  });

  it('skips a reminder another run or a client already changed', async () => {
    const { store, sender } = fakes([reminder()], { u1: [{ id: 'd1', token: 't1' }] });
    store.claim.mockResolvedValue(false);
    const report = await sendDue(store, sender, now);
    expect(sender.send).not.toHaveBeenCalled();
    expect(report.claimed).toBe(0);
  });

  it('still claims when the owner has no devices, so it is not retried forever', async () => {
    const { store, sender } = fakes([reminder()], {});
    expect((await sendDue(store, sender, now)).claimed).toBe(1);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('removes devices whose tokens are gone, and stops using them', async () => {
    const devices = {
      u1: [
        { id: 'd1', token: 't1' },
        { id: 'd2', token: 't2' },
      ],
    };
    const { store, sender } = fakes([reminder(), reminder({ id: 'r2' })], devices);
    sender.send.mockResolvedValueOnce(['gone', 'sent']).mockResolvedValueOnce(['sent']);
    const report = await sendDue(store, sender, now);
    expect(store.removeDevice).toHaveBeenCalledExactlyOnceWith('u1', 'd1');
    expect(sender.send).toHaveBeenLastCalledWith(['t2'], expect.anything());
    expect(store.devices).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ claimed: 2, sent: 2, failed: 1, removedDevices: 1 });
  });

  it('keeps a device after some other failure', async () => {
    const { store, sender } = fakes([reminder()], { u1: [{ id: 'd1', token: 't1' }] }, ['failed']);
    const report = await sendDue(store, sender, now);
    expect(store.removeDevice).not.toHaveBeenCalled();
    expect(report.failed).toBe(1);
  });
});

describe('messageFor', () => {
  it('opens the linked note, or Right Now', () => {
    expect(messageFor(reminder({ noteId: 'n 1' })).url).toBe('/?note=n%201');
    expect(messageFor(reminder())).toEqual({
      tag: 'r1',
      title: 'Call the bank',
      body: 'Right Now',
      url: '/right-now',
    });
  });
});
