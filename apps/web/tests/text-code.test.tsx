import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TextCode } from '~/cms/components/block-config/codemirror';

describe('the script code view', () => {
  it('draws characters that don’t show, so what is read is what runs', () => {
    const hidden = ['\u202b', '\u200d', '\u3164', '\u2068', '\u{e0041}'];
    const { container } = render(
      <TextCode value={hidden.map((c) => `a${c}b`).join('\n')} label="Import script" />,
    );
    expect(container.querySelectorAll('.cm-specialChar')).toHaveLength(hidden.length);
    expect(container.querySelector('[aria-label="Import script"]')).toBeTruthy();
  });
});
