import Base64Util from '../../vendor/scratch-vm/src/util/base64-util';

export const base64ToArrayBuffer = base64 => Base64Util.base64ToUint8Array(base64).buffer;
export const arrayBufferToBase64 = buffer => Base64Util.arrayBufferToBase64(buffer);
