import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { PPTXLoader } from "@langchain/community/document_loaders/fs/pptx";

export interface ChunkTextOptions {
  chunkSize: number;
  overlap: number;
}

const _splitterInstance = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 200,
});

export const chunkText = async (
  text: string,
  options?: ChunkTextOptions,
): Promise<
  {
    chunk: string;
    startIdx: number;
  }[]
> => {
  if (options) {
    _splitterInstance.chunkSize = options.chunkSize;
    _splitterInstance.chunkOverlap = options.overlap;
  } else {
    _splitterInstance.chunkSize = 1000;
    _splitterInstance.chunkOverlap = 200;
  }

  return _splitterInstance.splitText(text).then((chunks) =>
    chunks.map((chunk) => ({
      chunk,
      startIdx: text.indexOf(chunk), // TODO: (O(n^2)), splitter 내부에서 인덱스를 가져와야 함
    })),
  );
};

export const chunkPdf = async (
  pdf: Blob,
): Promise<{ chunk: string; startIdx: number }[]> => {
  const pdfLoader = new PDFLoader(pdf, { splitPages: false });
  const [document] = await pdfLoader.load();

  return chunkText(document.pageContent);
};

export const chunkCsv = async (
  csv: Blob,
  delimiter: string,
): Promise<{ chunk: string; startIdx: number }[]> => {
  const csvLoader = new CSVLoader(csv, { separator: delimiter });
  const [document] = await csvLoader.load();

  return chunkText(document.pageContent);
};

export const chunkDocx = async (
  docx: Blob,
): Promise<{ chunk: string; startIdx: number }[]> => {
  const docxLoader = new DocxLoader(docx);
  const [document] = await docxLoader.load();

  return chunkText(document.pageContent);
};

export const chunkPptx = async (
  pptx: Blob,
): Promise<{ chunk: string; startIdx: number }[]> => {
  const pptxLoader = new PPTXLoader(pptx);
  const [document] = await pptxLoader.load();

  return chunkText(document.pageContent);
};
