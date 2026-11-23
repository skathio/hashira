namespace Hashira.Fixture.NuGet;

/// <summary>The published surface the fixture's publish job checks after installing the package.</summary>
public static class Greeter
{
    public static string Greet(string name) => $"hello, {name}";
}
