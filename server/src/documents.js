import PDFDocument from "pdfkit";

// Documents the AI writes for the site (a price list, a menu to download). A PDF from a little
// Markdown: # and ## headings, - lists, plain paragraphs, **bold** read as plain text.

// The PDF's built-in fonts only have Western letters: other scripts would come out as gibberish.
const OUTSIDE_FONT = /[^\t\n\r\x20-\x7e\xa0-\xff–—‘’“”•…€]/u;

/** Why this text can't go in a PDF, or null. */
export const pdfProblem = (text) => {
  const found = OUTSIDE_FONT.exec(text);
  return found ? `PDFs can only be made with Western letters so far, and "${found[0]}" isn't one` : null;
};

/** The PDF's bytes. */
export function makePdf({ title, content }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: title } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Helvetica-Bold").fontSize(22).text(title).moveDown(0.8);
    // The title is printed above, so the text repeating it as its first heading isn't.
    const body = content.trimStart().replace(/^#{1,2} +(.*)\r?\n?/, (line, heading) => (heading.trim() === title.trim() ? "" : line));
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim().replace(/\*\*(.+?)\*\*/g, "$1");
      if (!line) doc.moveDown(0.5);
      else if (line.startsWith("## ")) doc.moveDown(0.4).font("Helvetica-Bold").fontSize(13).text(line.slice(3)).moveDown(0.2);
      else if (line.startsWith("# ")) doc.moveDown(0.6).font("Helvetica-Bold").fontSize(16).text(line.slice(2)).moveDown(0.3);
      else if (/^[-*] /.test(line)) doc.font("Helvetica").fontSize(11).text(`•  ${line.slice(2)}`, { indent: 8 });
      else doc.font("Helvetica").fontSize(11).text(line);
    }
    doc.end();
  });
}
