import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://cbt_user:cbt_password@localhost:5432/lasustech_cbt?schema=public"
    }
  }
});

async function main() {
  console.log('Seeding admin user...');
  const adminPasswordHash = await bcrypt.hash('password123', 12);
  
  const adminRole = await prisma.role.upsert({
    where: { key: 'ADMIN' },
    update: {},
    create: {
      key: 'ADMIN',
      name: 'System Administrator'
    }
  });

  const admin = await prisma.user.upsert({
    where: { email: 'admin@lasustech.edu.ng' },
    update: { passwordHash: adminPasswordHash },
    create: {
      staffId: 'ADMIN/001',
      names: 'First Admin',
      email: 'admin@lasustech.edu.ng',
      passwordHash: adminPasswordHash,
      status: 'ACTIVE'
    }
  });

  const userRoleExists = await prisma.userRole.findFirst({
    where: { userId: admin.id, roleId: adminRole.id, scopeType: 'GLOBAL' }
  });

  if (!userRoleExists) {
    await prisma.userRole.create({
      data: {
        userId: admin.id,
        roleId: adminRole.id,
        scopeType: 'GLOBAL'
      }
    });
  }

  console.log('Admin user ready:', {
    id: admin.id,
    email: admin.email,
    staffId: admin.staffId,
    password: 'password123'
  });
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });