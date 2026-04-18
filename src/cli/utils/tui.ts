import { readSync } from 'fs';

function readKey(): string {
  const buf = Buffer.alloc(16);
  const n = readSync(0, buf, 0, buf.length, null);
  return buf.subarray(0, n).toString();
}

function readLine(prompt: string): string {
  process.stdout.write(prompt);
  const buf = Buffer.alloc(1024);
  const n = readSync(0, buf, 0, buf.length, null);
  return buf.subarray(0, n).toString().trim().replace(/\r/g, '');
}

/**
 * Presents a single-select prompt. Returns the label of the selected option.
 * Falls back to numbered input when stdin is not a TTY.
 */
export function selectOption(prompt: string, options: string[], defaultIndex = 0): string {
  let selected = defaultIndex;

  function render(initial = false) {
    if (!initial) {
      process.stdout.write(`\x1B[${options.length}A`);
    }
    for (let i = 0; i < options.length; i++) {
      const active = i === selected;
      const marker = active ? '\x1B[36m>\x1B[0m' : ' ';
      const label = active ? `\x1B[1m${options[i]}\x1B[0m` : `\x1B[2m${options[i]}\x1B[0m`;
      process.stdout.write(`\x1B[2K  ${marker} ${label}\n`);
    }
  }

  if (!process.stdin.isTTY) {
    console.log(prompt);
    options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
    const raw = readLine(`  Choose [${defaultIndex + 1}]: `);
    if (!raw) return options[defaultIndex];
    const num = parseInt(raw);
    if (num >= 1 && num <= options.length) return options[num - 1];
    return options[defaultIndex];
  }

  console.log(prompt);
  process.stdout.write('\x1B[?25l'); // hide cursor
  render(true);
  process.stdin.setRawMode(true);

  try {
    for (;;) {
      const key = readKey();

      if (key === '\r' || key === '\n') {
        break;
      } else if (key === '\x1B[A' || key === '\x1BOA') {
        // Up arrow
        selected = (selected - 1 + options.length) % options.length;
        render();
      } else if (key === '\x1B[B' || key === '\x1BOB') {
        // Down arrow
        selected = (selected + 1) % options.length;
        render();
      } else if (key === '\x03') {
        // Ctrl+C
        process.stdout.write('\x1B[?25h\n');
        process.stdin.setRawMode(false);
        process.exit(0);
      } else {
        // Number key quick-select
        const num = parseInt(key);
        if (num >= 1 && num <= options.length) {
          selected = num - 1;
          render();
          break;
        }
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdout.write('\x1B[?25h'); // show cursor
  }

  return options[selected];
}

/**
 * Prompts for a single line of text input.
 * Returns the entered value, or defaultValue if the user presses Enter without typing.
 */
export function textInput(prompt: string, defaultValue?: string): string {
  const displayPrompt = defaultValue ? `${prompt} (${defaultValue}): ` : `${prompt}: `;

  if (!process.stdin.isTTY) {
    const raw = readLine(displayPrompt);
    return raw || defaultValue || '';
  }

  process.stdout.write(displayPrompt);

  // Collect input character by character in raw mode so we can handle backspace
  process.stdin.setRawMode(true);
  let input = '';

  try {
    for (;;) {
      const key = readKey();

      if (key === '\r' || key === '\n') {
        process.stdout.write('\n');
        break;
      } else if (key === '\x03') {
        // Ctrl+C
        process.stdout.write('\n');
        process.stdin.setRawMode(false);
        process.exit(0);
      } else if (key === '\x7F' || key === '\x08') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\x08 \x08');
        }
      } else if (key.length === 1 && key >= ' ') {
        // Printable character
        input += key;
        process.stdout.write(key);
      }
    }
  } finally {
    process.stdin.setRawMode(false);
  }

  return input || defaultValue || '';
}

/**
 * Presents a multi-select prompt. Returns an array of selected option labels.
 * Falls back to space-separated numbered input when stdin is not a TTY.
 */
export function multiSelect(prompt: string, options: string[], defaults?: string[]): string[] {
  const defaultSet = new Set(defaults ?? []);
  const selected = new Set<number>(
    options.reduce<number[]>((acc, opt, i) => {
      if (defaultSet.has(opt)) acc.push(i);
      return acc;
    }, []),
  );
  let cursor = 0;

  function render(initial = false) {
    if (!initial) {
      process.stdout.write(`\x1B[${options.length}A`);
    }
    for (let i = 0; i < options.length; i++) {
      const active = i === cursor;
      const checked = selected.has(i);
      const checkbox = checked ? '\x1B[32m[x]\x1B[0m' : '[ ]';
      const marker = active ? '\x1B[36m>\x1B[0m' : ' ';
      const label = active ? `\x1B[1m${options[i]}\x1B[0m` : options[i];
      process.stdout.write(`\x1B[2K  ${marker} ${checkbox} ${label}\n`);
    }
  }

  if (!process.stdin.isTTY) {
    console.log(`${prompt} (enter numbers separated by spaces, or press Enter for defaults):`);
    options.forEach((opt, i) => {
      const isDefault = defaultSet.has(opt);
      console.log(`  ${i + 1}) ${opt}${isDefault ? ' [default]' : ''}`);
    });
    const defaultNums = options
      .map((opt, i) => (defaultSet.has(opt) ? String(i + 1) : null))
      .filter(Boolean)
      .join(' ');
    const raw = readLine(`  Choose [${defaultNums || 'none'}]: `);
    if (!raw) return options.filter(opt => defaultSet.has(opt));
    return raw
      .split(/\s+/)
      .map(s => parseInt(s))
      .filter(n => n >= 1 && n <= options.length)
      .map(n => options[n - 1]);
  }

  console.log(`${prompt} \x1B[2m(Space to toggle, Enter to confirm)\x1B[0m`);
  process.stdout.write('\x1B[?25l');
  render(true);
  process.stdin.setRawMode(true);

  try {
    for (;;) {
      const key = readKey();

      if (key === '\r' || key === '\n') {
        break;
      } else if (key === '\x1B[A' || key === '\x1BOA') {
        // Up arrow
        cursor = (cursor - 1 + options.length) % options.length;
        render();
      } else if (key === '\x1B[B' || key === '\x1BOB') {
        // Down arrow
        cursor = (cursor + 1) % options.length;
        render();
      } else if (key === ' ') {
        // Space: toggle selection
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
        render();
      } else if (key === '\x03') {
        // Ctrl+C
        process.stdout.write('\x1B[?25h\n');
        process.stdin.setRawMode(false);
        process.exit(0);
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdout.write('\x1B[?25h');
  }

  return options.filter((_, i) => selected.has(i));
}
