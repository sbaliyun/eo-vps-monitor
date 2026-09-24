package main

import (
	"crypto/x509"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWebsiteHTTPProbeReportsCertificateExpiry(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	result := executeWebsiteHTTPProbeWithClient(WebsiteProbeTask{ID: 7, URL: server.URL, Method: "HEAD", TimeoutSec: 5}, server.Client())
	if !result.OK {
		t.Fatalf("probe should succeed: %+v", result)
	}
	leaf := server.Certificate()
	want := leaf.NotAfter.UTC().Format(time.RFC3339)
	if result.CertExpiresAt != want {
		t.Fatalf("cert_expires_at = %q, want %q", result.CertExpiresAt, want)
	}
}

func TestWebsiteHTTPProbeWithoutTLSHasNoCertificate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer server.Close()
	result := executeWebsiteHTTPProbeWithClient(WebsiteProbeTask{ID: 8, URL: server.URL, TimeoutSec: 5}, server.Client())
	if result.CertExpiresAt != "" || result.CertIssuer != "" {
		t.Fatalf("plain HTTP must not report a certificate: %+v", result)
	}
}

func TestCertificateFailureReason(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{x509.CertificateInvalidError{Reason: x509.Expired}, "cert_expired"},
		{x509.CertificateInvalidError{Reason: x509.NotAuthorizedToSign}, "cert_invalid"},
		{x509.HostnameError{Host: "example.com", Certificate: &x509.Certificate{}}, "cert_hostname_mismatch"},
		{x509.UnknownAuthorityError{}, "cert_untrusted"},
		{errors.New("connection refused"), ""},
	}
	for _, c := range cases {
		if got := certificateFailureReason(c.err); got != c.want {
			t.Errorf("certificateFailureReason(%T) = %q, want %q", c.err, got, c.want)
		}
		if c.want != "" && probeFailureReason(c.err) != c.want {
			t.Errorf("probeFailureReason(%T) should classify certificate errors", c.err)
		}
	}
}

func TestReportAdvertisesSSLCertFeature(t *testing.T) {
	found := false
	for _, feature := range agentFeatures {
		if feature == "ssl_cert" {
			found = true
		}
	}
	if !found {
		t.Fatal("agent must advertise ssl_cert so the server can assign certificate checks")
	}
}
