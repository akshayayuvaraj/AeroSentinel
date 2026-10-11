// Advisory may be issued only for a human-VERIFIED incident with HIGH exposure and sufficient evidence.
permit (principal, action == Action::"IssueAdvisory", resource)
when { resource.status == "VERIFIED" && resource.exposure == "HIGH" && resource.evidenceScore >= context.threshold };
