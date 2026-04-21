export interface ChatEncryptionProvider {
  encrypt(plaintext: string, roomId: string): Promise<string>;
  decrypt(ciphertext: string, roomId: string): Promise<string>;
}
