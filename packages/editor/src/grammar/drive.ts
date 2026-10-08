// Google Drive links (#50): a note keeps the link as written; the app
// draws it as a Drive chip, and the MCP server hands Claude the file id
// its own Drive connector opens. No Drive API, no scopes.
import type { Link, Root } from 'mdast';
import { visit } from 'unist-util-visit';

/** What a Drive link points at, from its URL. */
export interface DriveFile {
  id: string;
  /** e.g. 'Google Doc'; 'Drive file' when the URL does not say. */
  kind: string;
  url: string;
}

const DOCS_KINDS: Record<string, string> = {
  document: 'Google Doc',
  spreadsheets: 'Google Sheet',
  presentation: 'Google Slides',
  forms: 'Google Form',
  drawings: 'Google Drawing',
};

/** The Drive file a URL names, or undefined for any other URL. */
export function driveFile(url: string): DriveFile | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:') return undefined;
  const id = (s: string | undefined | null) => (s && /^[\w-]{10,}$/.test(s) ? s : undefined);
  if (u.hostname === 'docs.google.com') {
    // An account segment (u/0/) may come before d/ (review on #101).
    const m =
      /^\/(document|spreadsheets|presentation|forms|drawings)\/(?:u\/\d+\/)?d\/([^/]+)/.exec(
        u.pathname,
      );
    const found = id(m?.[2]);
    return found ? { id: found, kind: DOCS_KINDS[m![1]], url } : undefined;
  }
  if (u.hostname === 'drive.google.com') {
    const file = /^\/file\/(?:u\/\d+\/)?d\/([^/]+)/.exec(u.pathname)?.[1];
    const folder = /^\/drive\/(?:u\/\d+\/)?folders\/([^/]+)/.exec(u.pathname)?.[1];
    const open = u.pathname === '/open' ? u.searchParams.get('id') : undefined;
    const found = id(file ?? open);
    if (found) return { id: found, kind: 'Drive file', url };
    const dir = id(folder);
    if (dir) return { id: dir, kind: 'Drive folder', url };
  }
  return undefined;
}

/** The Drive files a note links to, once each, in order. */
export function driveFiles(root: Root): DriveFile[] {
  const seen = new Map<string, DriveFile>();
  visit(root, 'link', (node: Link) => {
    const file = driveFile(node.url);
    if (file && !seen.has(file.id)) seen.set(file.id, file);
  });
  return [...seen.values()];
}
