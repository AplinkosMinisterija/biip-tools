import mime from 'mime-types';
import Moleculer, { Errors } from 'moleculer';

export const IMAGE_FILE_EXTENTIONS: { [key: string]: string } = {
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export const DOCUMENT_FILE_EXTENTIONS: { [key: string]: string } = {
  pdf: 'application/pdf',
};

export const DOCUMENT_CONTENT_TYPES = Object.values(DOCUMENT_FILE_EXTENTIONS);
export const IMAGE_CONTENT_TYPES = Object.values(IMAGE_FILE_EXTENTIONS);
export const FILE_CONTENT_TYPES = [...IMAGE_CONTENT_TYPES, ...DOCUMENT_CONTENT_TYPES];

export const FILE_EXTENTIONS: { [key: string]: string } = {
  ...IMAGE_FILE_EXTENTIONS,
  ...DOCUMENT_FILE_EXTENTIONS,
};

export function getExtention(mimetype: string) {
  return mime.extension(mimetype);
}

export function getMimetype(filename: string) {
  return mime.lookup(filename);
}

export function throwUnsupportedMimetypeError(): Errors.MoleculerError {
  throw new Moleculer.Errors.MoleculerClientError(
    'Unsupported MIME type.',
    400,
    'UNSUPPORTED_MIMETYPE',
  );
}

export function throwUnableToUploadError(): Errors.MoleculerError {
  throw new Moleculer.Errors.MoleculerClientError(
    'Unable to upload file.',
    400,
    'UNABLE_TO_UPLOAD',
  );
}

export function getPublicFileName(length: number = 30) {
  function makeid(length: number) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

  return makeid(length);
}
