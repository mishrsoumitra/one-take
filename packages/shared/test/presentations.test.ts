import { describe, expect, it } from 'vitest';

import { PRESENTATION_EXTENSIONS, PRESENTATION_MIME_TYPES, presentationExtension } from '../src/index.js';

describe('presentations', () => {
  it('recognises presentation files by name only', () => {
    expect(presentationExtension('Lecture 3.pptx')).toBe('pptx');
    expect(presentationExtension('show.PPSX')).toBe('ppsx');
    expect(presentationExtension('macros.pptm ')).toBe('pptm');
    expect(presentationExtension('old.ppt')).toBeNull();
    expect(presentationExtension('slides.pdf')).toBeNull();
    expect(presentationExtension('pptx')).toBeNull();
    expect(presentationExtension('')).toBeNull();
  });

  it('has a MIME type for every extension', () => {
    for (const ext of PRESENTATION_EXTENSIONS) expect(PRESENTATION_MIME_TYPES[ext]).toMatch(/^application\//);
  });
});
