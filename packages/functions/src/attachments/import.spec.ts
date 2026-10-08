import { describe, expect, it, vi } from 'vitest';
import {
  type ImportStore,
  fileNameFrom,
  importLink,
  isPublicAddress,
  pageText,
  publicFetch,
} from './import';
import { TEXT_METADATA } from './process';

function store() {
  return {
    write: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  } satisfies ImportStore;
}

const html = (s: string) => ({
  contentType: 'text/html; charset=utf-8',
  bytes: new TextEncoder().encode(s),
});

describe('importLink', () => {
  it('keeps a page as its title and text', async () => {
    const s = store();
    const fetchPage = vi.fn(async () =>
      html(
        '<html><head><title>Seeds &amp; soil</title><style>p{}</style></head>' +
          '<body><script>x()</script><h1>Seeds</h1><p>Plant in&nbsp;spring.</p></body></html>',
      ),
    );
    const url = 'https://example.com/seeds';
    expect(await importLink(s, fetchPage, 'u1', 'a1', { kind: 'link', url, name: url })).toBe(
      'page',
    );
    const textPath = 'users/u1/attachments/a1/text_page.txt';
    expect(s.write).toHaveBeenCalledWith(
      textPath,
      new TextEncoder().encode('Seeds\nPlant in spring.'),
      'text/plain; charset=utf-8',
      TEXT_METADATA,
    );
    expect(s.update).toHaveBeenCalledWith('u1', 'a1', { textPath, name: 'Seeds & soil' });
  });

  it('keeps a name it was given, and takes a PDF as the attachment’s file', async () => {
    const s = store();
    const pdf = new TextEncoder().encode('%PDF-1.7 rest');
    const fetchPage = vi.fn(async () => ({ contentType: 'application/octet-stream', bytes: pdf }));
    const url = 'https://example.com/papers/On%20Seeds.pdf?dl=1';
    expect(
      await importLink(s, fetchPage, 'u1', 'a2', { kind: 'link', url, name: 'The seed paper' }),
    ).toBe('pdf');
    const path = 'users/u1/attachments/a2/On-Seeds.pdf';
    // Unmarked: the upload trigger reads its text.
    expect(s.write).toHaveBeenCalledWith(path, pdf, 'application/pdf');
    expect(s.update).toHaveBeenCalledWith('u1', 'a2', {
      kind: 'pdf',
      path,
      contentType: 'application/pdf',
      size: pdf.length,
    });
  });

  it('says why a link could not be kept, and leaves others alone', async () => {
    const s = store();
    const failing = vi.fn(async () => {
      throw new Error('example.internal is not a public address');
    });
    expect(
      await importLink(s, failing, 'u1', 'a3', { kind: 'link', url: 'http://example.internal/' }),
    ).toBe('failed');
    expect(s.update).toHaveBeenCalledWith('u1', 'a3', {
      importError: 'example.internal is not a public address',
    });
    const image = vi.fn(async () => ({ contentType: 'image/png', bytes: Uint8Array.from([1]) }));
    expect(
      await importLink(s, image, 'u1', 'a4', { kind: 'link', url: 'https://x.test/a.png' }),
    ).toBe('failed');
    expect(await importLink(s, failing, 'u1', 'a5', { kind: 'image', url: 'x' })).toBe('skipped');
    expect(
      await importLink(s, failing, 'u1', 'a6', { kind: 'link', url: 'x', textPath: 'done' }),
    ).toBe('skipped');
  });
});

describe('the fetch guard', () => {
  it('knows public addresses from private ones', () => {
    for (const ok of ['93.184.216.34', '2606:2800:220:1::1'])
      expect(isPublicAddress(ok)).toBe(true);
    for (const no of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::7f00:1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::1',
      '2001:0:4136:e378::1',
      'metadata.google.internal',
    ]) {
      expect(isPublicAddress(no)).toBe(false);
    }
  });

  it('refuses other schemes and private hosts before fetching', async () => {
    await expect(publicFetch('file:///etc/passwd')).rejects.toThrow('only http and https');
    await expect(publicFetch('http://169.254.169.254/computeMetadata/v1/')).rejects.toThrow(
      'not a public address',
    );
    await expect(publicFetch('http://[::1]:8080/')).rejects.toThrow('not a public address');
    await expect(publicFetch('http://localhost/')).rejects.toThrow('not a public address');
  });
});

describe('the fetch guard on redirects', () => {
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

  it('checks every hop: a private host, another scheme, too many hops', async () => {
    const fetchMock = vi.fn(async () => redirect('http://169.254.169.254/latest'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(publicFetch('http://93.184.216.34/a')).rejects.toThrow('not a public address');
      expect(fetchMock).toHaveBeenCalledOnce();
      fetchMock.mockImplementation(async () => redirect('file:///etc/passwd'));
      await expect(publicFetch('http://93.184.216.34/a')).rejects.toThrow('only http and https');
      fetchMock.mockImplementation(async () => redirect('http://93.184.216.34/again'));
      await expect(publicFetch('http://93.184.216.34/a')).rejects.toThrow('too many redirects');
      expect(fetchMock).toHaveBeenCalledTimes(1 + 1 + 6);
      fetchMock.mockImplementation(
        async () => new Response('<title>Hi</title>', { headers: { 'content-type': 'text/html' } }),
      );
      const page = await publicFetch('http://93.184.216.34/a');
      expect(new TextDecoder().decode(page.bytes)).toBe('<title>Hi</title>');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('names and text', () => {
  it('names a PDF from its URL', () => {
    expect(fileNameFrom('https://x.test/a/b/Paper%20One.PDF')).toBe('Paper-One.PDF');
    expect(fileNameFrom('https://x.test/download?id=3')).toBe('download.pdf');
    expect(fileNameFrom('https://x.test/')).toBe('document.pdf');
  });

  it('reads entities and keeps lines', () => {
    expect(pageText('<p>a &lt;b&gt; &#233;&#x00e9;</p><li>c</li>').text).toBe('a <b> éé\nc');
  });
});
