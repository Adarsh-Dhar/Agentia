import {prisma} from '../lib/prisma.ts';
async function main() {
  // Find all walletAddresses with more than one user
  const duplicates = await prisma.user.groupBy({
    by: ["walletAddress"],
    _count: { walletAddress: true },
    having: { walletAddress: { _count: { gt: 1 } } },
  });

  for (const dup of duplicates) {
    const users = await prisma.user.findMany({
      where: { walletAddress: dup.walletAddress },
      orderBy: { createdAt: "asc" },
    });
    // Keep the first, delete the rest
    const [ , ...toDelete] = users;
    for (const user of toDelete) {
      await prisma.user.delete({ where: { id: user.id } });
      console.log(`Deleted duplicate user with id: ${user.id}`);
    }
  }

  if (duplicates.length === 0) {
    console.log("No duplicate users found.");
  } else {
    console.log("Duplicate cleanup complete.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
