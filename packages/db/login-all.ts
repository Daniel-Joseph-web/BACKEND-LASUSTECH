import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function loginAllUsers() {
  console.log('\n🔐 Authenticating all system users...\n');

  const users = await prisma.user.findMany({
    include: { roles: { include: { role: true } } },
  });

  const allTokens: Record<string, string> = {};
  const rolesProcessed = new Set();

  for (const user of users) {
    // Only GLOBAL grants are institutional authority (see auth.service.ts).
    const roleName = user.roles.find((r) => r.scopeType === 'GLOBAL')?.role?.key || 'UNKNOWN';
    const email = user.email || 'No Email';

    // Optional: limit to one user per role to keep the output clean
    if (rolesProcessed.has(roleName)) continue;
    rolesProcessed.add(roleName);

    const loginRes = await fetch('http://localhost:3001/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: email, password: 'ChangeMe123!' }),
    });

    if (loginRes.ok) {
      const json = await loginRes.json();
      const token = json.data.accessToken;
      
      allTokens[`${roleName}_TOKEN`] = token;
      
      console.log(`✅ [${roleName.padEnd(14)}] ${email}`);
      console.log(`🔑 ${token}\n`);
    } else {
      console.log(`❌ [${roleName.padEnd(14)}] ${email} -> Login Failed`);
    }
  }

  // Save the tokens to a file for easy access later
  fs.writeFileSync('test-tokens.json', JSON.stringify(allTokens, null, 2));
  console.log('📄 All active tokens have been saved to packages/db/test-tokens.json\n');
}

loginAllUsers().catch(console.error);