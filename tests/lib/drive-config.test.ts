// Drive settings copied from a terminal can pick up line breaks, spaces or
// quotes; the client must ignore them and never alter the value otherwise.
import { describe, expect, test } from "vitest";
import { createDriveClient } from "../../app/services/drive.server";

describe("Drive settings", () => {
  test("off unless all four are set", () => {
    expect(createDriveClient({} as NodeJS.ProcessEnv)).toBeNull();
    expect(createDriveClient({ GOOGLE_OAUTH_CLIENT_ID: "a", GOOGLE_OAUTH_CLIENT_SECRET: "b", GOOGLE_OAUTH_REFRESH_TOKEN: "c" } as NodeJS.ProcessEnv)).toBeNull();
  });
  test("stray whitespace and quotes are removed; letters are kept", () => {
    const drive = createDriveClient({
      GOOGLE_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "1//0gtoken\r\nsss",
      DRIVE_ROOT_FOLDER_ID: ' "1AbcSsDef" ',
    } as NodeJS.ProcessEnv);
    expect(drive?.rootId).toBe("1AbcSsDef");
  });
});
