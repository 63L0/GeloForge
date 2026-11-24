# Interrupted checkout benchmark

From the source checkout run `node scripts/benchmark-resume.mjs prepare`. It prints a fresh temporary trial root and the common task prompt. Each arm starts with identical application code and the same failing visible test. The three arms add, respectively, nothing, a maintainer-style handoff note, or GeloForge records from a real failed verification. The note is a supplied baseline.

Open each arm as the working directory of a separate fresh agent session. Use the same client, model, reasoning effort, time limit and permissions within a comparison. Give every session the printed prompt. For the note arm also point to HANDOFF.md. For the GeloForge arm provide the output of `node /absolute/path/to/scripts/geloforge.mjs resume` run inside that arm. Include that output in input token accounting. Allow follow-up reads in every arm. Keep the sibling directories, grader and other conversations outside the session's accessible workspace. Rotate arm order across repetitions.

Run `node scripts/benchmark-resume.mjs grade <trial-root>` outside the sessions. It returns one boolean per arm and a nonzero status if any arm fails. Grade timeouts count as failures. The independent checks cover empty, whitespace-only and valid addresses.

Record one row per trial: client/model and version, arm, trial number, grade, elapsed seconds from prompt delivery to final answer, human corrections, and total input/output tokens across all turns when available. Record unavailable metrics as unknown. Keep failed attempts. Run at least three fresh repetitions per arm before comparing. Repeat on another client to examine portability.

For a deterministic installation check run `node scripts/benchmark-resume.mjs self-test`. This exercises all three arms with a known bad starter and reference fix. A self-test establishes grader behavior only. This single small task does not establish real-world speed, quality or adoption.
