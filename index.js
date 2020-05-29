const core = require('@actions/core');
const github = require('@actions/github');
const glob = require('@actions/glob');
const parser = require('xml2json');
const fs = require('fs');

console.log(JSON.stringify(process.env, null, 2));

async function invokeOnOneOrMany(oneOrMany, fn) {
  if (Array.isArray(oneOrMany)) {
    for (const one of oneOrMany) {
      await fn(one)
    }
  } else {
    await fn(oneOrMany)
  }
}

(async () => {
  try {
    const path = core.getInput('path');
    const numFailures = core.getInput('numFailures');
    const accessToken = core.getInput('access-token');
    const globber = await glob.create(path, { followSymbolicLinks: false });
    const commitSha = core.getInput('commitSha');

    let numTests = 0;
    let numSkipped = 0;
    let numFailed = 0;
    let numErrored = 0;
    let testDuration = 0;

    let annotations = [];

    for await (const file of globber.globGenerator()) {
      const data = await fs.promises.readFile(file);
      let json = JSON.parse(parser.toJson(data));
      if (json.testsuites) json = json.testsuites;

      await invokeOnOneOrMany(json.testsuite, async testsuite => {
        testDuration += Number(testsuite.time);
        numTests += Number(testsuite.tests);
        numErrored += Number(testsuite.errors);
        numFailed += Number(testsuite.failures);
        numSkipped += Number(testsuite.skipped);
        await invokeOnOneOrMany(testsuite.testcase, async testcase => {
          let failure = testcase.failure || testcase.error;
          let failureReason = 'failed';
          if (testcase.error) {
            failureReason = 'errored';
          }

          if (failure) {
            if (annotations.length < numFailures) {
              let path = testcase.file || testsuite.filepath;
              path = path.replace(`${process.env.GITHUB_WORKSPACE}/`, '');
              let line = Number(testcase.lineno || 1);

              let message = '';
              let fullMessage = failure;
              if ('object' === typeof failure) {
                message = failure.message;
                fullMessage = failure.$t;
              }

              annotations.push({
                path: path,
                start_line: line,
                end_line: line,
                start_column: 0,
                end_column: 0,
                annotation_level: 'failure',
                message: `${testcase.name} ${failureReason} ${message}\n\n${fullMessage}`,
              });
            }
          }
        });
      });
    }

    const octokit = new github.GitHub(accessToken);
    const req = {
      ...github.context.repo,
      ref: commitSha
    };
    const res = await octokit.checks.listForRef(req);
    console.log(JSON.stringify(res, null, 2));

    const check_run_id = res.data.check_runs.filter(run => run.name === process.env.GITHUB_JOB)[0].id;

    const annotation_level = numFailed + numErrored > 0 ? 'failure' : 'notice';
    let resultMessage = `Tests ran ${numTests} in ${testDuration} seconds. ${numErrored} Errored, ${numFailed} Failed, ${numSkipped} Skipped`;
    const annotation = {
      path: 'test',
      start_line: 0,
      end_line: 0,
      start_column: 0,
      end_column: 0,
      annotation_level,
      message: resultMessage,
    };


    const update_req = {
      ...github.context.repo,
      check_run_id,
      output: {
        title: "Test Results",
        summary: resultMessage,
        annotations: [annotation, ...annotations]
      }
    }
    await octokit.checks.update(update_req);
  } catch (error) {
    core.setFailed(error.message);
  }
})();
