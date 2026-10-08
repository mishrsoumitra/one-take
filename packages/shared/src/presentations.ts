/**
 * Slide decks that are not PDFs. The browser cannot draw them, so the local server turns them into a PDF
 * with its own JavaScript renderer (no PowerPoint, LibreOffice or browser involved), and the browser then
 * renders that PDF as usual. Only the Office Open XML family is understood.
 */

export const PRESENTATION_EXTENSIONS = ['pptx', 'ppsx', 'pptm'] as const;
export type PresentationExtension = (typeof PRESENTATION_EXTENSIONS)[number];

/** MIME types browsers report for these files (not reliable across platforms, so names decide). */
export const PRESENTATION_MIME_TYPES: Record<PresentationExtension, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
};

/** What the server says about deck conversion in its capabilities. */
export interface PresentationSupport {
  extensions: PresentationExtension[];
  /** The libraries doing the work, for the UI and bug reports. */
  renderer: string;
}

/** The lower-case extension when the name ends in one of the known presentation types, else null. */
export function presentationExtension(fileName: string): PresentationExtension | null {
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  const ext = m?.[1]?.toLowerCase();
  if (!ext) return null;
  return (PRESENTATION_EXTENSIONS as readonly string[]).includes(ext) ? (ext as PresentationExtension) : null;
}
