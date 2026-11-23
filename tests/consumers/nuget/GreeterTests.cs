using Xunit;

namespace Hashira.Fixture.NuGet;

public class GreeterTests
{
    [Fact]
    public void GreetSaysHelloToTheNameItIsGiven()
    {
        Assert.Equal("hello, hashira", Greeter.Greet("hashira"));
    }
}
