process.stdout.write("locked\n");

const { promise, resolve } = Promise.withResolvers<void>();
process.once("SIGTERM", resolve);
process.once("SIGINT", resolve);
process.stdin.once("end", resolve);
process.stdin.resume();
await promise;
process.exit(0);
