---
description: DeepSeek bir projeyi baştan sona yazsın (c2f)
---
Use the c2f tools. Follow these steps exactly. Talk to the user in their language.

1. If "$ARGUMENTS" is empty: say `/ctf <ne yapılacak>` and stop.
2. Call `c2f_status` once. If no line says "ready", show the user the line as it is (it names the command that fixes it) and STOP.
3. Call `c2f_build` ONCE with request = "$ARGUMENTS". It writes into ./out of the current folder.
4. While the result says "running": tell the user the phase in one sentence (design / plan / step N of M / audit), then call `c2f_job` with that job id. Repeat until it is finished. Never call `c2f_build` while a job is running.
5. If it ends as `failed`:
   - The error says to wait, or to sign in (`c2f giris`): tell the user exactly that and STOP. Calling it again makes it worse.
   - Anything else: call `c2f_build` once more with the same request and `resume: true`. If that fails too, report and stop.
6. Report only what the tool returned: where the files are, which steps did not finish, whether the audit gave a verdict. `finished_with_problems` is not success: say so plainly.
