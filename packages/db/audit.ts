import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function auditRoles() {
  console.log('\n🛡️ Initiating Military-Grade Role Audit...\n');

  // 1. Clear the lockdown from the brute-force test
  await prisma.user.updateMany({
    data: { lockedUntil: null, failedLoginCount: 0 },
  });
  console.log('🔓 Security locks reset. Commencing penetration test...\n');

  // 2. Fetch one user for each role in the system
  const users = await prisma.user.findMany({
    include: { roles: { include: { role: true } } },
  });

  const rolesTested = new Set();
  const PORTAL: Record<string, string> = {
    ADMIN: 'admin',
    LECTURER: 'lecturer',
    STUDENT: 'student',
  };

  for (const user of users) {
    // Only GLOBAL grants are institutional authority (see auth.service.ts).
    const roleName = user.roles.find((r) => r.scopeType === 'GLOBAL')?.role?.key;
    if (!roleName || rolesTested.has(roleName)) continue;
    rolesTested.add(roleName);

    // 3. Authenticate to get the JWT, through the entrance for this role.
    const loginRes = await fetch('http://localhost:3001/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: user.email,
        password: 'ChangeMe123!',
        portal: PORTAL[roleName],
      }),
    });

    if (!loginRes.ok) {
      console.log(`❌ [${roleName}] Login Failed for ${user.email}`);
      continue;
    }

    // FIX: Properly extract the token from the 'data' wrapper
    const json = await loginRes.json();
    const accessToken = json.data.accessToken;

    // 4. Attempt unauthorized access to the Admin panel
    const adminRes = await fetch('http://localhost:3001/api/v1/admin/ping', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const status = adminRes.status;
    
    // 5. Log the results clearly
    if (status === 200 || status === 201) {
      console.log(`🚨 [${roleName.padEnd(14)}] ${user.email.padEnd(35)} -> ✅ ALLOWED (Admin Access Granted)`);
    } else if (status === 403) {
      console.log(`🛡️  [${roleName.padEnd(14)}] ${user.email.padEnd(35)} -> ⛔ BLOCKED (Properly Forbidden)`);
    } else {
      console.log(`⚠️  [${roleName.padEnd(14)}] ${user.email.padEnd(35)} -> ❓ UNKNOWN (Status ${status})`);
    }
  }
  
  console.log('\n✅ Audit Complete.\n');
}

auditRoles().catch(console.error);