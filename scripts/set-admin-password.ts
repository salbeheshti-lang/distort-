// DISTORT — Set admin password
// Run: bun run scripts/set-admin-password.ts <email> <password>
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/admin-session";

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error("Usage: bun run scripts/set-admin-password.ts <email> <password>");
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("Password must be at least 8 characters");
    process.exit(1);
  }

  // Find or create user
  let user = await db.user.findFirst({ where: { email: email.toLowerCase() } });
  if (!user) {
    user = await db.user.create({
      data: {
        email: email.toLowerCase(),
        name: "Admin",
        isAdmin: true,
      },
    });
    console.log(`Created new admin user: ${email}`);
  }

  // Set password
  const passwordHash = hashPassword(password);
  await db.user.update({
    where: { id: user.id },
    data: {
      isAdmin: true,
      passwordHash,
    },
  });

  console.log(`✅ Admin password set for ${email}`);
  console.log(`   User can now log in at /admin with email + password`);
  console.log(`   Session expires after 24 hours`);
  console.log(`   DISTORT_SESSION_SECRET: ${process.env.DISTORT_SESSION_SECRET ? "set" : "NOT SET (using random)"}`);
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
