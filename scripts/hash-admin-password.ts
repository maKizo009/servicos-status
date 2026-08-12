/**
 * Gera o hash scrypt da senha do admin (formato scrypt:N:salt:hash).
 * Uso: bun run scripts/hash-admin-password.ts <senha>
 * Saída: copie o valor para a env ADMIN_PASSWORD_HASH na Vercel.
 */
import { hashPassword } from "../src/admin.js";

const senha = process.argv[2];
if (!senha || senha.length < 6) {
	console.error(
		"Uso: bun run scripts/hash-admin-password.ts <senha (mín. 6 chars)>",
	);
	process.exit(1);
}
console.log("ADMIN_PASSWORD_HASH=" + hashPassword(senha));
