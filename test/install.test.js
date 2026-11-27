import test from "node:test";
import assert from "node:assert/strict";
import { fixPath } from "../src/install.js";

test("putting c2f on PATH repairs it: doubled backslashes, a folder twice, the folder c2f moved away from", () => {
  // What an earlier `c2f kur` left behind: every backslash doubled, and a tool that added itself again since.
  const broken = "C:\\Users\\Kullanici\\AppData\\Local\\Programs\\arac\\bin;C:\\\\Users\\\\Kullanici\\\\AppData\\\\Local\\\\Programs\\\\arac\\\\bin;C:\\\\Users\\\\Kullanıcı\\\\Masaüstü\\\\araç;%USERPROFILE%\\\\bin;\\\\\\\\sunucu\\\\paylaşım;D:\\\\Eski\\\\ChatToFree;";
  const fixed = fixPath(broken, { repo: "E:\\Yeni\\ChatToFree", previous: "D:\\Eski\\ChatToFree" });
  assert.equal(fixed, "C:\\Users\\Kullanici\\AppData\\Local\\Programs\\arac\\bin;C:\\Users\\Kullanıcı\\Masaüstü\\araç;%USERPROFILE%\\bin;\\\\sunucu\\paylaşım;E:\\Yeni\\ChatToFree");
  assert.equal(fixPath(fixed, { repo: "E:\\Yeni\\ChatToFree" }), fixed, "a right PATH is left as it is");
  assert.equal(fixPath(fixed, { repo: "e:\\yeni\\chattofree" }), fixed, "spelled differently, it is still the same folder: nothing to write");
  assert.equal(fixPath(fixed, { repo: "E:\\Yeni\\ChatToFree", remove: true }), "C:\\Users\\Kullanici\\AppData\\Local\\Programs\\arac\\bin;C:\\Users\\Kullanıcı\\Masaüstü\\araç;%USERPROFILE%\\bin;\\\\sunucu\\paylaşım");
});
