using Xunit;

namespace Hashira.RunTestsDotnetFixture;

// Trivial single passing test so `dotnet test` exits 0 and Coverlet
// emits a cobertura.xml the action can then copy to coverage_path.
public class PassingTests
{
    [Fact]
    public void Truth() => Assert.True(true);
}
