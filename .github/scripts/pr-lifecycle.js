module.exports = async ({ github, context, core }) => {
  const repo = context.repo;
  let prs = [];

  // Determine if triggered by a pull_request event or a cron schedule
  if (context.eventName === 'pull_request') {
    prs = [context.payload.pull_request];
  } else if (context.eventName === 'schedule' || context.eventName === 'workflow_dispatch') {
    // Fetch all open PRs for cron processing
    const { data } = await github.rest.pulls.list({
      owner: repo.owner,
      repo: repo.repo,
      state: 'open',
    });
    prs = data;
  }

  for (const pr of prs) {
    if (pr.state !== 'open') continue;

    const prNumber = pr.number;
    
    // Retrieve existing metadata and comment ID from dedicated bot comments
    let { commentId, metadata } = await getBotComment(github, repo, prNumber);

    const now = new Date();
    let updated = false;

    // --- EVENT: PR Opened or Ready for Review ---
    if (context.eventName === 'pull_request' && ['opened', 'ready_for_review'].includes(context.payload.action)) {
      if (context.payload.action === 'opened' && pr.draft) {
        // Rule 1: Does NOT apply to a Draft PR[cite: 2]
        continue;
      }
      
      if (!metadata.staleTimerEnd) {
        // Rule 1: Every new PR gets a `needs-class` tag and a 60-minute Stale PR timer[cite: 2]
        await github.rest.issues.addLabels({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          labels: ['needs-class'],
        });

        const staleEnd = new Date(now.getTime() + 60 * 60 * 1000);
        metadata.staleTimerEnd = staleEnd.toISOString();
        metadata.warnedStale = false;

        await github.rest.issues.createComment({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          body: `A 60-minute Stale PR timer has begun and is set to end on ${staleEnd.toUTCString()}.

(This bot is here to assist in managing the [Social Web Working Group publishing rules](https://github.com/w3c/socialwg/blob/main/governance/publication-workflow.md) for comment periods and objections.)`,
        });
        updated = true;
      }
    }

    // --- EVENT: PR Labelled ---
    if (context.eventName === 'pull_request' && context.payload.action === 'labeled') {
      const labelName = context.payload.label.name;
      const sender = context.payload.sender ? context.payload.sender.login : 'Someone';

      if (['class-1', 'class-2'].includes(labelName)) {
        // Rule 2: 15-minute Comment Period timer + comment-open label[cite: 2]
        const commentEnd = new Date(now.getTime() + 15 * 60 * 1000);
        metadata.commentPeriodEnd = commentEnd.toISOString();

        await github.rest.issues.addLabels({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          labels: ['comment-open'],
        });

        // Remove needs-class label when comment-open is added
        await removeNeedsClass(github, repo, prNumber);
        
        await github.rest.issues.createComment({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          body: `A 15 minute comment window has begun and is set to end on ${commentEnd.toUTCString()}.`,
        });
        updated = true;
      } else if (['class-3', 'class-4'].includes(labelName)) {
        // Rule 3: 30-minute Comment Period timer + comment-open label[cite: 2]
        const commentEnd = new Date(now.getTime() + 30 * 60 * 1000);
        metadata.commentPeriodEnd = commentEnd.toISOString();

        await github.rest.issues.addLabels({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          labels: ['comment-open'],
        });

        // Remove needs-class label when comment-open is added
        await removeNeedsClass(github, repo, prNumber);

        await github.rest.issues.createComment({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          body: `A 30 minute comment window has begun and is set to end on ${commentEnd.toUTCString()}.`,
        });
        updated = true;
      } else if (labelName === 'objections-open') {
        // Rule 4: Stop comment period timer, add comment-paused label[cite: 2]
        metadata.commentPeriodEnd = null;

        await github.rest.issues.addLabels({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          labels: ['comment-paused'],
        });

        await github.rest.issues.createComment({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          body: `@${sender} has noted an objection, so the Comment Period timer has stopped.`,
        });
        updated = true;
      } else if (labelName === 'objections-resolved') {
        // Rule 5: 15-minute Post Resolution timer, update labels[cite: 2]
        const postResEnd = new Date(now.getTime() + 15 * 60 * 1000);
        metadata.postResolutionTimerEnd = postResEnd.toISOString();

        try {
          await github.rest.issues.removeLabel({
            owner: repo.owner,
            repo: repo.repo,
            issue_number: prNumber,
            name: 'comment-paused',
          });
        } catch (e) { /* ignore if label wasn't present */ }

        try {
          await github.rest.issues.removeLabel({
            owner: repo.owner,
            repo: repo.repo,
            issue_number: prNumber,
            name: 'objections-open',
          });
        } catch (e) { /* ignore if label wasn't present */ }

        await github.rest.issues.addLabels({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          labels: ['comment-open'],
        });

        // Remove needs-class label when comment-open is re-added
        await removeNeedsClass(github, repo, prNumber);

        await github.rest.issues.createComment({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          body: `@${sender} has noted that all open objections have been resolved and a 15-minute Post Resolution timer for further comment has started, set to end on ${postResEnd.toUTCString()}.`,
        });
        updated = true;
      }
    }

    // --- CRON / TIMER CHECKS (Rules 3.5, 6, 7) ---
    if (metadata.commentPeriodEnd && new Date(metadata.commentPeriodEnd) <= now) {
      // Rule 3.5: Comment Period timer is done, remove comment-open label[cite: 2]
      await github.rest.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: prNumber,
        body: 'The comment period is now over. WG Chair is expected to evaluate whether this should be merged or closed based on the [Social Web Working Group publishing rules](https://github.com/w3c/socialwg/blob/main/governance/publication-workflow.md).',
      });

      try {
        await github.rest.issues.removeLabel({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          name: 'comment-open',
        });
      } catch (e) { /* ignore */ }

      try {
        await github.rest.issues.addLabels({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          labels: ['comment-closed'],
        });
      } catch (e) { /* ignore */ }

      metadata.commentPeriodEnd = null;
      updated = true;
    }

    // Post Resolution Timer Expiration
    if (metadata.postResolutionTimerEnd && new Date(metadata.postResolutionTimerEnd) <= now) {
      await github.rest.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: prNumber,
        body: 'The post-resolution comment period is now over.',
      });

      try {
        await github.rest.issues.removeLabel({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          name: 'comment-open',
        });
      } catch (e) { /* ignore */ }

      try {
        await github.rest.issues.addLabels({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          labels: ['comment-closed'],
        });
      } { catch (e)  /* ignore */ }

      metadata.postResolutionTimerEnd = null;
      updated = true;
    }

    if (metadata.staleTimerEnd) {
      let staleEnd = new Date(metadata.staleTimerEnd);
      
      // Rule 6 Extension Adjustment Logic (Minute-based)
      if (metadata.postResolutionTimerEnd) {
        const postResEnd = new Date(metadata.postResolutionTimerEnd);
        if (postResEnd > staleEnd) {
          staleEnd = postResEnd;
          metadata.staleTimerEnd = staleEnd.toISOString();
          updated = true;
        }
      }

      // Check for 10-minute warning reminder and label (Rule 6)[cite: 2]
      const tenMinutesBeforeStale = new Date(staleEnd.getTime() - 10 * 60 * 1000);
      if (!metadata.warnedStale && now >= tenMinutesBeforeStale && now < staleEnd) {
        await github.rest.issues.addLabels({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          labels: ['closure-warning'],
        });

        await github.rest.issues.createComment({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          body: `Reminder: This issue will close in ten minutes if not merged (impending closure scheduled for ${staleEnd.toUTCString()}).`,
        });
        metadata.warnedStale = true;
        updated = true;
      }

      // Rule 7: When Stale PR timer is done (or passed), close the PR[cite: 2]
      if (now >= staleEnd) {
        await github.rest.issues.createComment({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: prNumber,
          body: 'Automatically closing because no resolution was reached by the end of the review window.',
        });
        await github.rest.pulls.update({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: prNumber,
          state: 'closed',
        });
        continue;
      }
    }

    // Upsert/Update the dedicated bot state comment if tracking has started or changes occurred
    if (metadata.staleTimerEnd || metadata.commentPeriodEnd || metadata.postResolutionTimerEnd || updated) {
      commentId = await upsertBotComment(github, repo, prNumber, commentId, metadata);
    }
  }
};

// Helper: Safely remove the needs-class label
async function removeNeedsClass(github, repo, prNumber) {
  try {
    await github.rest.issues.removeLabel({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: prNumber,
      name: 'needs-class',
    });
  } catch (e) {
    // Ignore if the label wasn't attached
  }
}

// Helper: Scan comments to find the one containing our hidden tracking signature
async function getBotComment(github, repo, prNumber) {
  const { data: comments } = await github.rest.issues.listComments({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: prNumber,
  });

  for (const comment of comments) {
    const match = comment.body.match(/<!-- pr-lifecycle: (.*?) -->/);
    if (match && match[1]) {
      try {
        return {
          commentId: comment.id,
          metadata: JSON.parse(match[1]),
        };
      } catch (e) {
        // Ignore malformed JSON
      }
    }
  }

  return {
    commentId: null,
    metadata: { staleTimerEnd: null, commentPeriodEnd: null, postResolutionTimerEnd: null, warnedStale: false },
  };
}

// Helper: Create the bot state comment if it doesn't exist, or update it if it does
async function upsertBotComment(github, repo, prNumber, commentId, metadata) {
  const commentBody = `🤖 This comment stores our helper bot's *PR Lifecycle Automation State*, do not delete or edit! \n<!-- pr-lifecycle: ${JSON.stringify(metadata)} -->`;

  if (commentId) {
    await github.rest.issues.updateComment({
      owner: repo.owner,
      repo: repo.repo,
      comment_id: commentId,
      body: commentBody,
    });
    return commentId;
  } else {
    const { data: newComment } = await github.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: prNumber,
      body: commentBody,
    });
    return newComment.id;
  }
}
