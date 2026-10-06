import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { UnknownRoute, reloadPage } from './unknown-route';

async function render(updates: Partial<SwUpdate> | null) {
  TestBed.configureTestingModule({
    imports: [UnknownRoute],
    providers: [provideRouter([]), ...(updates ? [{ provide: SwUpdate, useValue: updates }] : [])],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const reload = vi.spyOn(reloadPage, 'run').mockImplementation(() => undefined);
  TestBed.createComponent(UnknownRoute);
  await new Promise((r) => setTimeout(r));
  return { navigate, reload };
}

describe('UnknownRoute', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reloads into a newer version that may know the path', async () => {
    const activateUpdate = vi.fn(async () => true);
    const { navigate, reload } = await render({
      isEnabled: true,
      checkForUpdate: vi.fn(async () => true),
      activateUpdate,
    });
    expect(activateUpdate).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('goes home when this is already the newest version', async () => {
    const { navigate, reload } = await render({
      isEnabled: true,
      checkForUpdate: vi.fn(async () => false),
    });
    expect(navigate).toHaveBeenCalledWith([''], { replaceUrl: true });
    expect(reload).not.toHaveBeenCalled();
  });

  it('goes home without a service worker', async () => {
    const { navigate } = await render(null);
    expect(navigate).toHaveBeenCalledWith([''], { replaceUrl: true });
  });
});
