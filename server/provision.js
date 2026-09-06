/**
 * Give a clinic its sign-in.
 *
 *   npm run provision -- --name "Hulhumale Medical" --island Hulhumale --atoll K \
 *                        --admin "Aishath Nadha" --username aishath.nadha
 *
 * Prints the clinic's sign-in address and the admin's first password, once.
 */
import { db } from './db.js';
import { provisionClinic } from './services/tenancy.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}
if (!args.name || !args.admin || !args.username) {
  console.error('usage: npm run provision -- --name "<clinic>" --island <island> --atoll <atoll> --admin "<admin name>" --username <username>');
  process.exit(1);
}
const out = provisionClinic({
  name: args.name, island: args.island, atoll: args.atoll, address: args.address, phone: args.phone,
  adminName: args.admin, adminUsername: args.username,
});
console.log(`
  Clinic:    ${args.name}
  Sign in:   http://localhost:${process.env.PORT || 3000}${out.signInPath}
  Admin:     ${out.admin.username}
  Password:  ${out.password}   (shown once — they will be asked to change it)
`);
db.close();
