// FILE: sshConfigHosts.test.ts
// Purpose: Verify private SSH metadata discovery without executing config commands.
// Layer: Desktop SSH tests
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSshConfigHosts } from "./sshConfigHosts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "moss-ssh-config-"));
  roots.push(root);
  return root;
}
describe("SSH config host inventory", () => {
  it("discovers concrete aliases and exposes only resolved display metadata", async () => {
    const root = await fixture(),
      config = join(root, "config");
    const text = `Host moss-mac MAC-SECOND\n HostName ssh.example.test\n User moss\n Port 2222\n IdentityFile "~/my keys/private_key"\n ProxyCommand cloudflared access ssh --hostname %h --token synthetic-do-not-return\nHost * !excluded\n Port 22\nHost excluded\n HostName excluded.test\n`;
    await writeFile(config, text);
    const result = await listSshConfigHosts(config, root);
    expect(result).toEqual([
      {
        alias: "moss-mac",
        host: "ssh.example.test",
        user: "moss",
        port: 2222,
        identityFile: join(homedir(), "my keys/private_key"),
        usesProxy: true,
      },
      {
        alias: "MAC-SECOND",
        host: "ssh.example.test",
        user: "moss",
        port: 2222,
        identityFile: join(homedir(), "my keys/private_key"),
        usesProxy: true,
      },
      { alias: "excluded", host: "excluded.test", port: 22, usesProxy: false },
    ]);
    expect(JSON.stringify(result)).not.toContain("synthetic-do-not-return");
    expect(await readFile(config, "utf8")).toBe(text);
  });

  it("honors include order, wildcards, aliases, first values and a bounded include cycle", async () => {
    const root = await fixture();
    await mkdir(join(root, "hosts with space"));
    await writeFile(
      join(root, "config"),
      'Include "hosts with space/*.conf"\nHost *\n User fallback\n',
    );
    await writeFile(
      join(root, "hosts with space/a.conf"),
      "Host staging stage-* !stage-private\n HostName %n.example.test\n User deploy\n ProxyJump bastion\nInclude config\n",
    );
    await writeFile(
      join(root, "hosts with space/b.conf"),
      "Host staging stage-private\n User ignored\n Port=2201\n",
    );
    expect(await listSshConfigHosts(join(root, "config"), root)).toEqual([
      {
        alias: "staging",
        host: "staging.example.test",
        user: "deploy",
        port: 2201,
        usesProxy: true,
      },
      {
        alias: "stage-private",
        host: "stage-private",
        user: "ignored",
        port: 2201,
        usesProxy: false,
      },
    ]);
  });

  it("never executes Match exec while opening inventory and accepts missing config", async () => {
    const root = await fixture(),
      marker = join(root, "must-not-exist");
    await writeFile(
      join(root, "config"),
      `Host existing\n HostName resolved.test\nMatch exec "touch ${marker}"\n User hidden\nHost later\n Port 23\n`,
    );
    expect(await listSshConfigHosts(join(root, "config"), root)).toEqual([
      { alias: "existing", host: "resolved.test", port: 22, usesProxy: false },
      { alias: "later", host: "later", port: 23, usesProxy: false },
    ]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listSshConfigHosts(join(root, "absent"), root)).toEqual([]);
  });

  it("bounds metadata input rather than reading arbitrary large files", async () => {
    const root = await fixture();
    await writeFile(join(root, "config"), "#".repeat(256 * 1024 + 1));
    await expect(listSshConfigHosts(join(root, "config"), root)).rejects.toThrow(
      "ssh-config-limit",
    );
  });
});
