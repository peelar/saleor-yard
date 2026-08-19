package sandboxd

import (
	"strings"
	"testing"
)

func TestComposeOverrideUsesTheExactCoreAndDashboardVersions(t *testing.T) {
	t.Parallel()
	job := validJob()
	result := composeOverride(job)

	for _, expected := range []string{
		"image: saleor-sandbox-core:" + job.Commit,
		"image: ghcr.io/saleor/saleor-dashboard:" + job.DashboardTag,
		`DASHBOARD_URL: "` + job.PrivateURL + `/"`,
		`PUBLIC_URL: "` + job.PrivateURL + `"`,
		`API_URL: "/graphql/"`,
		`APP_MOUNT_URI: "/"`,
		`--concurrency=1`,
		`"8080:80"`,
	} {
		if !strings.Contains(result, expected) {
			t.Fatalf("compose override does not contain %q", expected)
		}
	}
}

func TestInvestigationWorkerUsesOneProcess(t *testing.T) {
	t.Parallel()
	result := composeOverride(validJob())
	worker := result[strings.Index(result, "  worker:"):strings.Index(result, "  dashboard:")]
	if !strings.Contains(worker, "--concurrency=1") {
		t.Fatal("the investigation worker must use one process")
	}
}

func TestGatewayRoutesCorePathsBeforeDashboard(t *testing.T) {
	t.Parallel()
	configuration := nginxConfiguration(validJob())
	core := strings.Index(configuration, "location ~ ^/(graphql|media|thumbnail|static)/")
	dashboard := strings.Index(configuration, "location / {")
	if core == -1 || dashboard == -1 || core >= dashboard {
		t.Fatal("gateway must define the Core route before the Dashboard catch-all")
	}
}

func TestNginxConfigurationUsesAccessURLScheme(t *testing.T) {
	t.Parallel()
	job := validJob()
	job.PrivateURL = "http://127.0.0.1:28080"
	configuration := nginxConfiguration(job)
	if strings.Count(configuration, "X-Forwarded-Proto http;") != 2 {
		t.Fatalf("local proxy scheme was not rendered correctly:\n%s", configuration)
	}
}
