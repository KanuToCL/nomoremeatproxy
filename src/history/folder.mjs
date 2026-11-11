// Whether two folder paths name the same folder, however each tool wrote them: a trailing
// slash anywhere, and on Windows either kind of slash and any letter case. Elsewhere a
// backslash is an ordinary character of a name.
export function folderKey(folder, platform = process.platform) {
  const text = String(folder ?? '');
  const plain = platform === 'win32' ? text.replaceAll('\\', '/').toLowerCase() : text;
  return plain.replace(/\/+$/, '');
}

export const sameFolder = (a, b, platform = process.platform) => Boolean(a) && Boolean(b) && folderKey(a, platform) === folderKey(b, platform);
