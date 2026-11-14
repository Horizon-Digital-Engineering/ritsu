/**
 * Hidden-input prompt for passwords. On a terminal the characters are not
 * echoed; piped input reads one line, so a script can feed it.
 */
export async function promptSecret(label: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0]?.replace(/\r$/, '') ?? '';
  }
  stderr.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  return new Promise<string>((resolve, reject) => {
    const finish = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { finish(); resolve(value); return; }
        if (ch === '\u0003') { finish(); reject(new Error('interrupted')); return; }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
