# Evidence-Backed Bugfix Checklist

Use selectively before marking a bugfix ready for review:

- [ ] Reproduced the original failure or documented the static trigger clearly.
- [ ] Identified the root cause rather than masking symptoms or relaxing assertions.
- [ ] Added or updated an automated regression test covering the edge case.
- [ ] Re-ran the full relevant test suite cleanly after the final edit.
- [ ] Checked cross-platform paths (`/` vs `\`), CRLF/LF behavior, and error paths.
- [ ] Recorded real command output (`geloforge evidence capture`) and separated verified checks from manual observations.
